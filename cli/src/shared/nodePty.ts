import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * node-pty starts processes on macOS through a small `spawn-helper`
 * executable. Its prebuilt copies (node-pty 1.1) are published without the
 * execute bit, so every spawn fails with "posix_spawnp failed". Restores the
 * bit where missing; harmless when node-pty was built from source. Never throws.
 */
export function fixSpawnHelper(platform: NodeJS.Platform = process.platform, arch: string = process.arch): void {
  if (platform === 'win32') return;
  let root: string;
  try {
    // node-pty's main is lib/index.js
    root = path.dirname(path.dirname(require.resolve('node-pty')));
  } catch {
    return;
  }
  for (const helper of [
    path.join(root, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(root, 'build', 'Release', 'spawn-helper'),
  ]) {
    try {
      const { mode } = fs.statSync(helper);
      if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o755);
    } catch {
      // missing, or not ours to change (e.g. installed by root): spawning reports it
    }
  }
}

/** Loads node-pty (throws if it is not installed), ready to spawn. */
export function loadNodePty<T>(): T {
  // Dynamic require so node-pty remains a truly optional runtime dependency.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require('node-pty') as T;
  fixSpawnHelper();
  return pty;
}
