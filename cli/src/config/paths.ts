import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolves every file clipcmd reads or writes. Paths are computed on each call
 * (not at module load) so the CLIPCMD_CONFIG_DIR override is honoured even when
 * it is set after import — the test suites rely on this for isolation.
 *
 * Everything lives under ~/.config/clipcmd/ by default.
 */
export function getConfigDir(): string {
  const override = process.env.CLIPCMD_CONFIG_DIR;
  if (override && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.config', 'clipcmd');
}

export function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function getPortFile(): string {
  return path.join(getConfigDir(), 'port');
}

export function getLogFile(): string {
  return path.join(getConfigDir(), 'daemon.log');
}

/**
 * Present after `clipcmd stop`: shells and `clipcmd shell` then do not start
 * the daemon automatically until `clipcmd start` is run again.
 */
export function getStoppedMarker(): string {
  return path.join(getConfigDir(), 'stopped');
}

/** Directory holding one output capture file per shell session (see capture.ts). */
export function getSessionsDir(): string {
  return path.join(getConfigDir(), 'sessions');
}
