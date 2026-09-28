/**
 * CLI entry point for clipcmd.
 * Parses the command name from argv and dispatches to the appropriate command module.
 * Requirements: 11.1
 */
import { run as runInit } from './commands/init';
import { run as runShell } from './commands/shell';
import { run as runStart } from './commands/start';
import { run as runStatus } from './commands/status';
import { run as runStop } from './commands/stop';
import { run as runUninstall } from './commands/uninstall';

const USAGE = `Usage: clipcmd <command>

Commands:
  init [shell]       Install shell hooks for automatic copy buttons (zsh, bash, fish)
  start              Start the clipcmd background daemon
  stop               Stop the clipcmd background daemon
  status             Show daemon status
  uninstall [shell]  Remove shell hooks
  shell              Start shell in PTY wrapper for output capture (requires node-pty)
`;

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  init: runInit,
  start: runStart,
  stop: runStop,
  status: runStatus,
  uninstall: runUninstall,
  shell: runShell,
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  const args = argv.slice(1);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { version } = require('../../package.json') as { version: string };
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  return handler(args);
}

/**
 * Runs the CLI and sets the process exit code. Used by bin/clipcmd.js.
 */
export function run(argv: string[] = process.argv.slice(2)): void {
  main(argv).then(
    (code) => finish(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      finish(1);
    }
  );
}

function finish(code: number): void {
  process.exitCode = code;
  // Let stdout drain and exit naturally; the unref'd timer only fires if a
  // native handle (node-pty keeps one after the PTY exits) would hang the CLI.
  setTimeout(() => process.exit(code), 250).unref();
}

if (require.main === module) {
  run();
}
