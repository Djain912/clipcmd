/**
 * `clipcmd doctor` command
 * Checks everything clipcmd depends on and says how to fix what is missing.
 * Exits 1 if something is broken (warnings alone exit 0).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../config/config';
import { getConfigFile, getLogFile } from '../../config/paths';
import { getHookFilePath, getConfigPath, isInstalled } from '../../installer/installer';
import { blocksProfileScripts, getPowerShellInfo } from '../../installer/powershell';
import {
  desktopEntry,
  getHandlerScriptPath,
  getRegisteredCommand,
  isProtocolHandlerInstalled,
  linuxDesktopFile,
  urlScheme,
} from '../../installer/protocolHandler';
import { isPowerShell, SUPPORTED_SHELLS, SupportedShell } from '../../installer/shellDetector';
import { findWindowsTerminalSettings, parseJsonc } from '../../installer/windowsTerminal';
import { describePid, getDaemonState } from '../../shared/daemonClient';
import { isStoppedByUser } from './start';

export type Level = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  level: Level;
  title: string;
  fix?: string;
}

const LABEL: Record<Level, string> = { ok: ' OK ', warn: 'WARN', fail: 'FAIL', info: 'INFO' };

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Shells worth checking on this platform (PowerShell hooks only exist where PowerShell does). */
function relevantShells(): SupportedShell[] {
  return SUPPORTED_SHELLS.filter((shell) => process.platform === 'win32' || shell !== 'powershell');
}

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  const [major] = process.versions.node.split('.').map(Number);
  checks.push(
    major >= 20
      ? { level: 'ok', title: `Node.js ${process.versions.node}` }
      : { level: 'fail', title: `Node.js ${process.versions.node} is too old`, fix: 'Install Node.js 20 or newer.' }
  );

  const warnings: string[] = [];
  ConfigManager.load((w) => warnings.push(w));
  checks.push(
    warnings.length === 0
      ? { level: 'ok', title: `Config ${fs.existsSync(getConfigFile()) ? getConfigFile() : '(defaults)'}` }
      : { level: 'warn', title: `Config problems: ${warnings.join('; ')}`, fix: `Edit ${getConfigFile()}.` }
  );

  const state = await getDaemonState();
  if (state.state === 'running') {
    checks.push({ level: 'ok', title: `Daemon running on port ${state.port}${describePid(state.pid)}` });
  } else if (isStoppedByUser()) {
    checks.push({ level: 'warn', title: 'Daemon stopped with `clipcmd stop`', fix: 'Run `clipcmd start`.' });
  } else {
    checks.push({
      level: 'warn',
      title: `Daemon not running (${state.state})`,
      fix: `It starts with your next terminal, or run \`clipcmd start\`. Log: ${getLogFile()}`,
    });
  }

  const hooked = relevantShells().filter((shell) => {
    try {
      return isInstalled(shell);
    } catch {
      return false;
    }
  });
  checks.push(
    hooked.length > 0
      ? { level: 'ok', title: `Shell hook installed for: ${hooked.join(', ')}` }
      : { level: 'fail', title: 'No shell hook installed', fix: 'Run `clipcmd init` in the shell you use.' }
  );
  for (const shell of hooked) {
    // A hook from an older clipcmd lacks features (and fixes) of this version
    const current = fs.readFileSync(getHookFilePath(shell), 'latin1').replace(/\r\n/g, '\n').trimEnd();
    let installed = '';
    try {
      installed = fs.readFileSync(getConfigPath(shell), 'latin1');
    } catch {
      // unreadable: reported as outdated
    }
    if (!installed.replace(/\r\n/g, '\n').includes(current)) {
      checks.push({ level: 'warn', title: `The ${shell} hook is from another clipcmd version`, fix: `Run \`clipcmd init ${shell}\`.` });
    }
    if (isPowerShell(shell) && process.platform === 'win32') {
      const policy = getPowerShellInfo(shell).executionPolicy;
      if (blocksProfileScripts(policy)) {
        checks.push({
          level: 'fail',
          title: `PowerShell execution policy ${policy} blocks the profile`,
          fix: 'Run in PowerShell: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
        });
      }
    }
  }

  let pty = false;
  try {
    require('node-pty');
    pty = true;
  } catch {
    // reported below
  }
  checks.push(
    pty
      ? { level: 'ok', title: 'Output capture available (node-pty)' }
      : {
          level: 'warn',
          title: 'node-pty is missing: [COPY OUTPUT] only works in VS Code',
          fix: 'Reinstall clipcmd (`npm install -g clipcmd`); on Linux this needs python3, make and a C++ compiler.',
        }
  );

  const scheme = urlScheme();
  if (isProtocolHandlerInstalled()) {
    const command = getRegisteredCommand(scheme);
    if (process.platform === 'win32' && !command?.includes(getHandlerScriptPath())) {
      checks.push({ level: 'fail', title: `${scheme}:// is not registered to clipcmd`, fix: 'Run `clipcmd init`.' });
    } else if (process.platform === 'linux' && readText(linuxDesktopFile(scheme)) !== desktopEntry(scheme)) {
      // It runs node and clipcmd by absolute path, which change with upgrades
      checks.push({
        level: 'warn',
        title: `The ${scheme}:// link handler runs another Node.js or clipcmd installation`,
        fix: 'Run `clipcmd init` to update it.',
      });
    } else {
      checks.push({ level: 'ok', title: `Buttons copy silently (${scheme}:// links)` });
    }
  } else {
    checks.push({
      level: 'warn',
      title: 'Buttons open a browser tab (no clipcmd:// handler)',
      fix: 'Run `clipcmd init` to register silent clipcmd:// links.',
    });
  }

  if (process.platform === 'win32') {
    for (const file of findWindowsTerminalSettings()) {
      let allowed = false;
      try {
        const settings = parseJsonc(fs.readFileSync(file, 'utf8')) as { safeUriSchemes?: unknown };
        allowed = Array.isArray(settings.safeUriSchemes) && settings.safeUriSchemes.includes(scheme);
      } catch {
        // unreadable
      }
      checks.push(
        allowed
          ? { level: 'ok', title: `Windows Terminal allows ${scheme}:// links` }
          : {
              level: 'warn',
              title: `Windows Terminal asks before opening ${scheme}:// links`,
              fix: `Run \`clipcmd init\`, or add "safeUriSchemes": ["${scheme}"] to ${file}.`,
            }
      );
    }
  }

  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  const hasExtension = (() => {
    try {
      return fs.readdirSync(extensions).some((dir) => /^djain912\.clipcmd-/i.test(dir));
    } catch {
      return false;
    }
  })();
  checks.push(
    hasExtension
      ? { level: 'ok', title: 'VS Code extension installed' }
      : {
          level: 'info',
          title: 'VS Code extension not installed (optional: output capture in VS Code terminals)',
          fix: 'Install "clipcmd" from the VS Code Marketplace.',
        }
  );

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => `[${LABEL[c.level]}] ${c.title}${c.fix ? `\n       ${c.fix}` : ''}`);
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const summary =
    fails + warns === 0 ? 'Everything looks good.' : `${fails} problem(s), ${warns} warning(s).`;
  return `clipcmd doctor\n\n${lines.join('\n')}\n\n${summary}\n`;
}

export async function run(_args: string[]): Promise<number> {
  const checks = await runChecks();
  process.stdout.write(formatChecks(checks));
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
