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
import { getLogFile } from '../../config/paths';
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

export async function run(_args: string[]): Promise<number> {
  const state = await getDaemonState();
  if (state.state === 'running') {
    console.log(`Daemon is already running on port ${state.port}${describePid(state.pid)}`);
    return 0;
  }

  const daemonPath = getDaemonEntry();
  if (!fs.existsSync(daemonPath)) {
    console.error(`Daemon entry point not found at ${daemonPath}. Run \`npm run build\` first.`);
    return 1;
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
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    if (spawnError) break;

    const info = readPortFile();
    if (info && (await checkHealth(info.port, 1000))) {
      if (info.pid === child.pid) {
        console.log(`Daemon started on port ${info.port} (PID ${child.pid})`);
      } else {
        console.log(`Daemon is already running on port ${info.port}${describePid(info.pid)}`);
      }
      return 0;
    }

    // Our child is gone and nobody else is starting up: it failed.
    if (exited && !isDaemonLockHeld()) break;
  }

  if (spawnError) {
    console.error(`Failed to launch the daemon: ${spawnError.message}`);
    return 1;
  }

  console.error(
    exited
      ? `Daemon failed to start. See ${getLogFile()} for details.`
      : `Daemon did not become ready within ${READY_TIMEOUT_MS / 1000}s. See ${getLogFile()} for details.`
  );
  return 1;
}
