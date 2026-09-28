/**
 * `clipcmd start` command
 * Forks the daemon as a detached background process and waits until it is
 * reachable, so success is only reported once the daemon actually works.
 * Requirements: 1.1
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isDaemonLockHeld } from '../../config/daemonLock';
import { getLogFile, getStoppedMarker } from '../../config/paths';
import { readPortFile } from '../../config/portFile';
import { checkHealth, describePid, getDaemonState } from '../../shared/daemonClient';

const READY_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** dist/cli/commands/start.js → dist/daemon/index.js */
export function getDaemonEntry(): string {
  return path.resolve(__dirname, '../../daemon/index.js');
}

export type EnsureResult =
  | { status: 'running'; port: number; pid?: number }
  | { status: 'started'; port: number; pid: number }
  | { status: 'failed'; message: string };

/**
 * Starts the daemon unless one is already running, and waits until it
 * answers. Safe to call concurrently: the daemon's lock lets only one start.
 */
export async function ensureDaemon(timeoutMs = READY_TIMEOUT_MS): Promise<EnsureResult> {
  const state = await getDaemonState();
  if (state.state === 'running') return { status: 'running', port: state.port, pid: state.pid };

  const daemonPath = getDaemonEntry();
  if (!fs.existsSync(daemonPath)) {
    return { status: 'failed', message: `Daemon entry point not found at ${daemonPath}. Run \`npm run build\` first.` };
  }

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    // Without this, Windows opens a console window for the detached daemon.
    windowsHide: true,
  });

  let exited = false;
  let spawnError: Error | undefined;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', (err) => {
    spawnError = err;
    exited = true;
  });
  child.unref();

  // Wait for a healthy daemon: ours, or the one that won a concurrent start
  // (our child then exits on its own after seeing the lock).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (spawnError) break;

    const info = readPortFile();
    if (info && (await checkHealth(info.port, 1000))) {
      return child.pid !== undefined && info.pid === child.pid
        ? { status: 'started', port: info.port, pid: child.pid }
        : { status: 'running', port: info.port, pid: info.pid };
    }

    // Our child is gone and nobody else is starting up: it failed.
    if (exited && !isDaemonLockHeld()) break;
  }

  if (spawnError) return { status: 'failed', message: `Failed to launch the daemon: ${spawnError.message}` };
  return {
    status: 'failed',
    message: exited
      ? `Daemon failed to start. See ${getLogFile()} for details.`
      : `Daemon did not become ready within ${timeoutMs / 1000}s. See ${getLogFile()} for details.`,
  };
}

/** True after `clipcmd stop`: automatic starts (shells, `clipcmd shell`) stay off. */
export function isStoppedByUser(): boolean {
  return fs.existsSync(getStoppedMarker());
}

/**
 * `clipcmd start` (explicit) clears the stop marker; `clipcmd start --auto`
 * is what the shell hooks run, and it respects the marker.
 */
export async function run(args: string[]): Promise<number> {
  const quiet = args.includes('--quiet');
  if (args.includes('--auto')) {
    if (isStoppedByUser()) return 0;
  } else {
    fs.rmSync(getStoppedMarker(), { force: true });
  }
  const result = await ensureDaemon();
  switch (result.status) {
    case 'running':
      if (!quiet) console.log(`Daemon is already running on port ${result.port}${describePid(result.pid)}`);
      return 0;
    case 'started':
      if (!quiet) console.log(`Daemon started on port ${result.port} (PID ${result.pid})`);
      return 0;
    case 'failed':
      console.error(result.message);
      return 1;
  }
}
