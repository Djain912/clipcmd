/**
 * `clipcmd stop` command
 * Sends a shutdown request to the daemon and waits for it to exit. The
 * daemon then stays off — new shells do not restart it — until
 * `clipcmd start` is run again.
 * Requirements: 1.4
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStoppedMarker } from '../../config/paths';
import { isProcessAlive, readPortFile, removePortFileIfOwned } from '../../config/portFile';
import { describePid, getDaemonState, httpGet } from '../../shared/daemonClient';

const STOP_TIMEOUT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type StopResult =
  | { status: 'stopped'; pid?: number }
  | { status: 'not-running'; removedStale: boolean }
  | { status: 'failed'; message: string };

export async function stopDaemon(): Promise<StopResult> {
  const state = await getDaemonState();

  switch (state.state) {
    case 'not-running':
      return { status: 'not-running', removedStale: false };

    case 'stale':
      // -1 never matches a real pid, so only a pid-less legacy file or our stale one is removed.
      removePortFileIfOwned(state.pid ?? -1);
      return { status: 'not-running', removedStale: true };

    case 'unresponsive':
      // The pid may have been reused by an unrelated process, so never kill it blindly.
      return {
        status: 'failed',
        message:
          `Process ${state.pid} is registered as the daemon on port ${state.port} but is not responding. ` +
          'Stop it manually if it is a clipcmd daemon, then run `clipcmd start`.',
      };

    case 'running':
      break;
  }

  const { port, pid } = state;
  try {
    await httpGet(port, '/shutdown');
  } catch {
    // It may have exited before answering; the wait below decides.
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readPortFile()?.pid !== pid && (pid === undefined || !isProcessAlive(pid))) {
      return { status: 'stopped', pid };
    }
    await sleep(100);
  }
  return { status: 'failed', message: `Daemon${describePid(pid)} did not stop within ${STOP_TIMEOUT_MS / 1000}s` };
}

export async function run(_args: string[]): Promise<number> {
  // Written first, so a shell opening meanwhile does not start it again
  const marker = getStoppedMarker();
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
  } catch (err) {
    console.error(`Could not write ${marker} (${err instanceof Error ? err.message : String(err)}); new shells may start the daemon again.`);
  }

  const result = await stopDaemon();
  switch (result.status) {
    case 'stopped':
      console.log('Daemon stopped. It stays off until you run `clipcmd start`.');
      return 0;
    case 'not-running':
      console.log(result.removedStale ? 'Daemon is not running (removed stale port file)' : 'Daemon is not running');
      return 0;
    case 'failed':
      console.error(result.message);
      return 1;
  }
}
