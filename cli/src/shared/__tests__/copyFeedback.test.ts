import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCopiedTag, createCopyFeedback, getCopiedTagPath, removeCopiedTag } from '../copyFeedback';
import { makeTempDir, removeDir, waitFor } from '../../../test/helpers';

/** Records spawns; each child optionally fails like a missing program. */
function fakeSpawn(error?: Error) {
  const calls: Array<[string, string[]]> = [];
  const killed: number[] = [];
  const spawn = (command: string, args: string[]): ChildProcess => {
    const index = calls.push([command, args]) - 1;
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { unref: () => {}, kill: () => killed.push(index) > 0 });
    if (error) setImmediate(() => child.emit('error', error));
    return child;
  };
  return { calls, killed, spawn };
}

describe('copy confirmation on macOS and Linux', () => {
  it('macOS: a notification through osascript, with the message quoted', () => {
    const { calls, spawn } = fakeSpawn();
    createCopyFeedback(() => {}, { platform: 'darwin', spawn })!('Copied "x" \\ y');
    expect(calls).toEqual([['osascript', ['-e', 'display notification "Copied \\"x\\" \\\\ y" with title "clipcmd"']]]);
  });

  it('Linux: a short notify-send notification, and no more tries when it is not installed', async () => {
    const { calls, spawn } = fakeSpawn(Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' }));
    const confirm = createCopyFeedback(() => {}, { platform: 'linux', spawn })!;
    confirm('Copied command');
    expect(calls).toEqual([
      ['notify-send', ['--app-name=clipcmd', '--expire-time=1500', '--hint=int:transient:1', '--icon=edit-copy', 'clipcmd', 'Copied command']],
    ]);
    await new Promise((r) => setImmediate(r));
    confirm('Copied output');
    expect(calls.length).toBe(1);
  });

  it('none on other platforms', () => {
    expect(createCopyFeedback(() => {}, { platform: 'aix' })).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'win32')('the Windows "Copied" tag', () => {
  const saved = process.env.CLIPCMD_CONFIG_DIR;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    process.env.CLIPCMD_CONFIG_DIR = dir;
  });
  afterEach(() => {
    process.env.CLIPCMD_CONFIG_DIR = saved;
    removeDir(dir);
  });

  function measure(text: string): [number, number] {
    const r = spawnSync(getCopiedTagPath(), ['--measure', text], { encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(0);
    const [width, height] = r.stdout.trim().split('x').map(Number);
    return [width, height];
  }

  it('is compiled once per version, lays itself out, and is removed with the link handler', async () => {
    expect(await buildCopiedTag()).toBeUndefined();
    const exe = getCopiedTagPath();
    const built = fs.statSync(exe).mtimeMs;
    expect(await buildCopiedTag()).toBeUndefined();
    expect(fs.statSync(exe).mtimeMs).toBe(built);

    const [shortWidth, height] = measure('Copied output');
    const [longWidth] = measure('Copied command + output');
    expect(height).toBeGreaterThan(10);
    expect(shortWidth).toBeGreaterThan(height);
    expect(longWidth).toBeGreaterThan(shortWidth);

    // Another version is replaced by this one
    const older = path.join(path.dirname(exe), 'copied-00000000.exe');
    fs.writeFileSync(older, '');
    fs.rmSync(exe);
    expect(await buildCopiedTag()).toBeUndefined();
    expect(fs.existsSync(older)).toBe(false);

    removeCopiedTag();
    expect(fs.readdirSync(path.dirname(exe))).toEqual([]);
  }, 60000);

  it('the daemon builds it, then shows one per click, replacing the previous tag', async () => {
    const { calls, killed, spawn } = fakeSpawn();
    const logs: string[] = [];
    const confirm = createCopyFeedback((m) => logs.push(m), { platform: 'win32', spawn })!;
    confirm('Copied command'); // before the build finished
    await waitFor(() => calls.length === 1, 60000);
    confirm('Copied output');
    expect(calls).toEqual([
      [getCopiedTagPath(), ['Copied command']],
      [getCopiedTagPath(), ['Copied output']],
    ]);
    expect(killed).toEqual([0]);
    expect(logs).toEqual([]);
  }, 90000);

  // Shows a real tag at the mouse pointer, so only in CI, never on a developer's screen
  it.runIf(!!process.env.CI)('shows the tag and closes it by itself', async () => {
    expect(await buildCopiedTag()).toBeUndefined();
    const started = Date.now();
    const r = spawnSync(getCopiedTagPath(), ['Copied command'], { timeout: 15000 });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(1000);
  }, 60000);
});
