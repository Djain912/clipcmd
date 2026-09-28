/**
 * `clipcmd stop` command
 * Sends a shutdown request to the daemon and waits for it to exit.
 * Requirements: 1.4
 */
import { isProcessAlive, readPortFile, removePortFileIfOwned } from '../../config/portFile';
import { describePid, getDaemonState, httpGet } from '../../shared/daemonClient';

const STOP_TIMEOUT_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(_args: string[]): Promise<number> {
  const state = await getDaemonState();

  switch (state.state) {
    case 'not-running':
      console.log('Daemon is not running');
      return 0;

    case 'stale':
      // -1 never matches a real pid, so only a pid-less legacy file or our stale one is removed.
      removePortFileIfOwned(state.pid ?? -1);
      console.log('Daemon is not running (removed stale port file)');
      return 0;

    case 'unresponsive':
      // The pid may have been reused by an unrelated process, so never kill it blindly.
      console.error(
        `Process ${state.pid} is registered as the daemon on port ${state.port} but is not responding. ` +
          'Stop it manually if it is a clipcmd daemon, then run `clipcmd start`.'
      );
      return 1;

    case 'running':
      break;
  }

  const { port, pid } = state;
  try {
    await httpGet(port, '/shutdown');
  } catch {
    // It may have exited before answering; the wait below decides.
  }

  const stopped = () =>
    readPortFile()?.pid !== pid && (pid === undefined || !isProcessAlive(pid));

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (stopped()) {
      console.log('Daemon stopped');
      return 0;
    }
    await sleep(100);
  }

  console.error(`Daemon${describePid(pid)} did not stop within ${STOP_TIMEOUT_MS / 1000}s`);
  return 1;
}
