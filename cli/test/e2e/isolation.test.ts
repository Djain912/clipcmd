/**
 * Guard: the suite must never modify the user's real setup (the clipcmd://
 * registration, Windows Terminal's settings.json, the PowerShell profile,
 * ~/.config/clipcmd) or start daemons from the shell hooks. vitest.config.ts
 * gives every test process a throwaway URL scheme, empty data directories and
 * scratch paths; if that isolation is removed, this fails first.
 */
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfigDir } from '../../src/config/paths';
import { getConfigPath } from '../../src/installer/installer';
import { linuxDesktopFile, macAppPath, urlScheme } from '../../src/installer/protocolHandler';
import { findWindowsTerminalSettings } from '../../src/installer/windowsTerminal';
import { BIN } from '../helpers';

const tmp = path.resolve(os.tmpdir());
const inTmp = (p: string) => path.resolve(p).startsWith(tmp);

describe('test isolation from the real setup', () => {
  it('uses a throwaway URL scheme, never "clipcmd"', () => {
    expect(urlScheme()).toBe('clipcmd-vitest');
    expect(macAppPath()).toContain('clipcmd-vitest');
    expect(inTmp(linuxDesktopFile())).toBe(true);
  });

  it('cannot see the real Windows Terminal settings', () => {
    expect(process.env.LOCALAPPDATA).not.toBe(process.env.CLIPCMD_TEST_REAL_LOCALAPPDATA);
    expect(findWindowsTerminalSettings()).toEqual([]);
  });

  it('uses a scratch config directory, PowerShell profile and fish config', () => {
    expect(inTmp(getConfigDir())).toBe(true);
    expect(inTmp(getConfigPath('powershell'))).toBe(true);
    expect(inTmp(getConfigPath('pwsh'))).toBe(true);
    expect(inTmp(getConfigPath('fish'))).toBe(true);
  });

  it('keeps the shell hooks from starting daemons or wrapping themselves', () => {
    expect(process.env.CLIPCMD_AUTOSTART).toBe('0');
    expect(process.env.CLIPCMD_AUTOSHELL).toBe('0');
  });

  it('child processes (the CLI) inherit the isolation', () => {
    const r = spawnSync(
      process.execPath,
      ['-e', `const p=require(${JSON.stringify(path.resolve(BIN, '../../dist/installer/protocolHandler.js'))});console.log(p.urlScheme(), process.env.LOCALAPPDATA)`],
      { encoding: 'utf8' }
    );
    expect(r.stdout.trim()).toBe(`clipcmd-vitest ${process.env.LOCALAPPDATA}`);
  });
});
