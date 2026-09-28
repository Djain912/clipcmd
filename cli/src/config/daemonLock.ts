import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir } from './paths';
import { isProcessAlive, readPortFile } from './portFile';

/**
 * Single-instance guard. Two `clipcmd start`s at the same moment (e.g. from
 * two terminals opening at once) would otherwise both pass the "already
 * running?" check and leave an orphaned second daemon.
 */

/** A lock this young may belong to a daemon that has not written its Port_File yet. */
const STARTUP_GRACE_MS = 10000;

export function getLockFile(): string {
  return path.join(getConfigDir(), 'daemon.lock');
}

/**
 * True if the lock belongs to a live daemon. The owner pid alone is not
 * enough: after a crash the pid can be reused by an unrelated process, so an
 * old lock only counts if the Port_File names the same pid.
 */
function isLockLive(file: string): boolean {
  let owner: number;
  let ageMs: number;
  try {
    owner = Number(fs.readFileSync(file, 'utf8').trim());
    ageMs = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if (!Number.isInteger(owner) || owner <= 0) {
    // Empty: the owner created the file but has not written its pid yet
    return ageMs < STARTUP_GRACE_MS;
  }
  if (!isProcessAlive(owner)) return false;
  return ageMs < STARTUP_GRACE_MS || readPortFile()?.pid === owner;
}

/** Atomically claims the lock (O_EXCL create). Returns false if another daemon holds it. */
export function acquireDaemonLock(pid: number = process.pid): boolean {
  const file = getLockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (isLockLive(file)) return false;
      fs.rmSync(file, { force: true }); // stale: its owner is gone
    }
  }
  return false;
}

/** Releases the lock if (and only if) we own it. */
export function releaseDaemonLock(pid: number = process.pid): void {
  const file = getLockFile();
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file, { force: true });
  } catch {
    // Already gone
  }
}

/** True while some daemon is running or starting up. */
export function isDaemonLockHeld(): boolean {
  return isLockLive(getLockFile());
}
