/**
 * Guard: the suite must never modify the user's real Windows setup (the
 * clipcmd:// registration under HKCU, Windows Terminal's settings.json).
 * vitest.config.ts gives every test process a throwaway URL scheme and an
 * empty LOCALAPPDATA; if that isolation is removed, this fails first.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { urlScheme } from '../../src/installer/protocolHandler';
import { findWindowsTerminalSettings } from '../../src/installer/windowsTerminal';
import { BIN } from '../helpers';

describe('test isolation from the real Windows setup', () => {
  it('uses a throwaway URL scheme, never "clipcmd"', () => {
    expect(urlScheme()).toBe('clipcmd-vitest');
  });

  it('cannot see the real Windows Terminal settings', () => {
    expect(process.env.LOCALAPPDATA).not.toBe(process.env.CLIPCMD_TEST_REAL_LOCALAPPDATA);
    expect(findWindowsTerminalSettings()).toEqual([]);
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
