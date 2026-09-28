import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The set of shells supported by clipcmd. `powershell` is Windows PowerShell
 * 5.1 (powershell.exe); `pwsh` is PowerShell 7+.
 */
export type SupportedShell = 'zsh' | 'bash' | 'fish' | 'powershell' | 'pwsh';

export const SUPPORTED_SHELLS: SupportedShell[] = ['zsh', 'bash', 'fish', 'powershell', 'pwsh'];

export function isPowerShell(shell: SupportedShell): shell is 'powershell' | 'pwsh' {
  return shell === 'powershell' || shell === 'pwsh';
}

/**
 * Thrown by ShellDetector.detect() when the user's shell is not one of the
 * supported shells, or when it cannot be determined.
 */
export class UnsupportedShellError extends Error {
  constructor(shellValue: string | undefined) {
    const msg =
      shellValue === undefined || shellValue === ''
        ? `Could not detect your shell. Supported shells: ${SUPPORTED_SHELLS.join(', ')}. ` +
          'Pass the shell explicitly, e.g. `clipcmd init powershell` or `clipcmd init bash`.'
        : `Unsupported shell: "${shellValue}". Supported shells: ${SUPPORTED_SHELLS.join(', ')}` +
          (/^cmd(\.exe)?$/i.test(shellValue) ? ' (cmd.exe cannot run code around commands; use PowerShell)' : '');
    super(msg);
    this.name = 'UnsupportedShellError';
    // Maintain proper prototype chain for instanceof checks in transpiled ES5 targets
    Object.setPrototypeOf(this, UnsupportedShellError.prototype);
  }
}

/**
 * Maps a shell path or name (`/usr/bin/zsh`, `C:\Program Files\Git\bin\bash.exe`,
 * `pwsh`) to a SupportedShell, or undefined if it is not supported.
 */
export function parseShell(value: string): SupportedShell | undefined {
  // Handle both separators regardless of platform: Windows paths reach us on POSIX in tests.
  const basename = path.basename(value.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  return SUPPORTED_SHELLS.find((s) => s === basename);
}

/**
 * Picks the user's shell from the names of our ancestor processes, nearest
 * first (e.g. ['cmd.exe', 'powershell.exe', 'WindowsTerminal.exe']).
 *
 * npm runs global CLIs on Windows through a `clipcmd.cmd` shim, so one
 * leading cmd.exe is skipped; a second cmd.exe means the user really is in
 * cmd, which is not supported.
 */
export function pickShellFromAncestors(names: string[]): SupportedShell | undefined {
  let skippedShim = false;
  for (const name of names) {
    const base = name.toLowerCase().replace(/\.exe$/, '');
    if (base === 'cmd') {
      if (skippedShim) return undefined;
      skippedShim = true;
      continue;
    }
    const shell = parseShell(base);
    if (shell) return shell;
  }
  return undefined;
}

/** Names of this process's ancestors on Windows, nearest first (empty on failure). */
export function getWindowsAncestorNames(): string[] {
  const script =
    `$p = ${process.ppid}; ` +
    'for ($i = 0; $i -lt 8 -and $p -gt 0; $i++) { ' +
    '$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; ' +
    'if (-not $proc) { break }; $proc.Name; $p = $proc.ParentProcessId }';
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Detects the user's active shell.
 */
export interface ShellDetector {
  detect(): SupportedShell;
}

/**
 * Default implementation: SHELL (set by zsh/bash/fish and Git Bash), else on
 * Windows the nearest PowerShell ancestor process (PowerShell sets no SHELL).
 */
export class DefaultShellDetector implements ShellDetector {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly ancestors: () => string[] = getWindowsAncestorNames
  ) {}

  /**
   * Returns the detected SupportedShell.
   * @throws {UnsupportedShellError} if the shell is unknown or unsupported.
   */
  detect(): SupportedShell {
    const shellEnv = process.env.SHELL;

    if (shellEnv) {
      const matched = parseShell(shellEnv);
      if (!matched) {
        throw new UnsupportedShellError(shellEnv);
      }
      return matched;
    }

    if (this.platform === 'win32') {
      const names = this.ancestors();
      const fromAncestors = pickShellFromAncestors(names);
      if (fromAncestors) return fromAncestors;
      if (names.some((n) => /^cmd(\.exe)?$/i.test(n))) throw new UnsupportedShellError('cmd.exe');
    }

    throw new UnsupportedShellError(undefined);
  }
}

/**
 * Resolves the shell for `init`/`uninstall`: an explicit argument wins,
 * otherwise the shell is detected.
 * @throws {UnsupportedShellError}
 */
export function resolveShellArg(args: string[], detector: ShellDetector = new DefaultShellDetector()): SupportedShell {
  const explicit = args[0];
  if (explicit !== undefined) {
    const matched = parseShell(explicit);
    if (!matched) throw new UnsupportedShellError(explicit);
    return matched;
  }
  return detector.detect();
}
