import { execFile } from 'node:child_process';

export interface CliResult {
  /** Exit code; -1 when the process could not run or timed out. */
  code: number;
  stdout: string;
  stderr: string;
  /** The clipcmd executable was not found. */
  notFound: boolean;
}

const TIMEOUT_MS = 15000;

/**
 * Runs the clipcmd CLI (`cliPath`, or `clipcmd` from PATH). Never rejects.
 * On Windows the npm shim is clipcmd.cmd, which only runs through cmd.exe;
 * the arguments passed here are fixed strings, never user input.
 */
export function runCli(args: string[], cliPath = '', timeoutMs = TIMEOUT_MS): Promise<CliResult> {
  if (!args.every((arg) => /^[a-z-]+$/.test(arg))) throw new Error(`Unsafe clipcmd arguments: ${args.join(' ')}`);
  const command = cliPath.trim() || 'clipcmd';
  const windows = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      // cmd.exe gets one command line; the path is quoted, the arguments are plain words
      windows ? `"${command.replace(/"/g, '')}" ${args.join(' ')}` : command,
      windows ? [] : args,
      { shell: windows, windowsHide: true, timeout: timeoutMs },
      (err, stdout, stderr) => {
        const errno = (err as NodeJS.ErrnoException | null)?.code;
        const code = err ? (typeof errno === 'number' ? errno : -1) : 0;
        const out = String(stdout);
        const errText = String(stderr);
        const notFound =
          errno === 'ENOENT' || (windows && code !== 0 && /is not recognized|cannot find the path/i.test(errText));
        resolve({ code, stdout: out, stderr: errText, notFound });
      }
    );
  });
}
