import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireDaemonLock, getLockFile, isDaemonLockHeld, releaseDaemonLock } from '../daemonLock';
import { writePortFile } from '../portFile';
import { makeTempDir, removeDir } from '../../../test/helpers';

describe('daemon lock', () => {
  let dir: string;
  const saved = process.env.CLIPCMD_CONFIG_DIR;
  const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid as number;
  const age = (ms: number) => {
    const t = new Date(Date.now() - ms);
    fs.utimesSync(getLockFile(), t, t);
  };

  beforeEach(() => {
    dir = makeTempDir();
    process.env.CLIPCMD_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
    removeDir(dir);
  });

  it('is exclusive until released by its owner', () => {
    expect(acquireDaemonLock(process.pid)).toBe(true);
    expect(isDaemonLockHeld()).toBe(true);
    expect(acquireDaemonLock(process.pid + 100000)).toBe(false);
    releaseDaemonLock(process.pid + 100000); // not the owner: no effect
    expect(isDaemonLockHeld()).toBe(true);
    releaseDaemonLock(process.pid);
    expect(fs.existsSync(getLockFile())).toBe(false);
    expect(isDaemonLockHeld()).toBe(false);
  });

  it('takes over a lock whose owner has exited', () => {
    fs.writeFileSync(getLockFile(), String(deadPid()));
    expect(isDaemonLockHeld()).toBe(false);
    expect(acquireDaemonLock(process.pid)).toBe(true);
    expect(fs.readFileSync(getLockFile(), 'utf8')).toBe(String(process.pid));
  });

  it('takes over an old lock whose pid was reused by an unrelated process', () => {
    fs.writeFileSync(getLockFile(), String(process.pid)); // alive, but no daemon registered
    age(60000);
    expect(isDaemonLockHeld()).toBe(false);
    expect(acquireDaemonLock(12345)).toBe(true);
  });

  it('respects an old lock when the Port_File confirms the owner', () => {
    fs.writeFileSync(getLockFile(), String(process.pid));
    age(60000);
    writePortFile(9999, process.pid);
    expect(acquireDaemonLock(12345)).toBe(false);
  });

  it('treats a fresh empty lock as a daemon mid-startup, and an old empty one as stale', () => {
    fs.writeFileSync(getLockFile(), '');
    expect(acquireDaemonLock(12345)).toBe(false);
    age(60000);
    expect(acquireDaemonLock(12345)).toBe(true);
  });
});
