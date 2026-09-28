import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type PowerShellKind = 'powershell' | 'pwsh';

export interface PowerShellInfo {
  /** $PROFILE (current user, current host) — the file PowerShell loads last. */
  profile: string;
  /** Effective execution policy, when it could be determined. */
  executionPolicy?: string;
}

const cache = new Map<PowerShellKind, PowerShellInfo>();

function executable(kind: PowerShellKind): string {
  return kind === 'pwsh' ? 'pwsh' : 'powershell.exe';
}

/** Where the profile lives when PowerShell itself cannot be asked. */
export function defaultProfilePath(kind: PowerShellKind, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const folder = kind === 'pwsh' ? 'PowerShell' : 'WindowsPowerShell';
    return path.join(os.homedir(), 'Documents', folder, 'Microsoft.PowerShell_profile.ps1');
  }
  return path.join(os.homedir(), '.config', 'powershell', 'Microsoft.PowerShell_profile.ps1');
}

/**
 * Asks the PowerShell edition for its profile path and execution policy.
 * The Documents folder can be redirected (e.g. to OneDrive), so the path is
 * never guessed when PowerShell can tell us. CLIPCMD_POWERSHELL_PROFILE
 * overrides the profile path (non-standard setups, tests).
 */
export function getPowerShellInfo(kind: PowerShellKind): PowerShellInfo {
  const info = cache.get(kind) ?? queryPowerShell(kind);
  cache.set(kind, info);
  const override = process.env.CLIPCMD_POWERSHELL_PROFILE;
  return override ? { ...info, profile: override } : info;
}

/** Spawns the PowerShell edition once to read $PROFILE and the execution policy. */
function queryPowerShell(kind: PowerShellKind): PowerShellInfo {
  const script =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    '$PROFILE; ' +
    'if (Get-Command Get-ExecutionPolicy -ErrorAction Ignore) { Get-ExecutionPolicy } else { "Unrestricted" }';
  const result = spawnSync(executable(kind), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  const [profileLine, policyLine] = result.status === 0 ? result.stdout.split(/\r?\n/).map((l) => l.trim()) : [];

  return {
    profile: profileLine && path.isAbsolute(profileLine) ? profileLine : defaultProfilePath(kind),
    executionPolicy: policyLine || undefined,
  };
}

/**
 * Policies under which a local, unsigned profile script does not run:
 * PowerShell would print an error on every start instead of loading the hook.
 */
export function blocksProfileScripts(policy: string | undefined): boolean {
  return policy === 'Restricted' || policy === 'AllSigned';
}
