import { describePid, getDaemonState } from '../../shared/daemonClient';

/**
 * Implements `clipcmd status`.
 *
 * Reads ~/.config/clipcmd/port, checks whether the daemon is reachable via
 * GET /health, and prints a human-readable status message. Always exits 0:
 * a stopped daemon is a state, not an error, and the message says which.
 */
export async function run(_args: string[]): Promise<number> {
  const state = await getDaemonState();

  switch (state.state) {
    case 'running':
      console.log(`Daemon is running on port ${state.port}${describePid(state.pid)}`);
      return 0;

    case 'not-running':
      console.log('Daemon is not running');
      console.log('Run `clipcmd start` to start the daemon.');
      return 0;

    case 'stale':
      console.log('Daemon is not running (stale port file)');
      console.log('Run `clipcmd start` to start the daemon.');
      return 0;

    case 'unresponsive':
      console.log(`Daemon process ${state.pid} is alive but not responding on port ${state.port}`);
      return 0;
  }
}
