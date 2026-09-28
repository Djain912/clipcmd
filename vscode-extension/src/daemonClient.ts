import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Why the daemon is (un)available:
 * - running: the port file is valid and /health answers like a clipcmd daemon
 * - not-running: no port file (the daemon deletes it on a clean shutdown)
 * - invalid-port-file: the port file exists but is unreadable or malformed
 * - stale: the port file names a process that has exited (crash / hard kill)
 * - unreachable: nothing accepts connections on the registered port
 * - timeout: the port accepted the connection but did not answer in time
 * - not-clipcmd: something else answers on the port (e.g. the port was reused)
 */
export type DaemonState =
  | 'running'
  | 'not-running'
  | 'invalid-port-file'
  | 'stale'
  | 'unreachable'
  | 'timeout'
  | 'not-clipcmd';

export interface DaemonStatus {
  available: boolean;
  state: DaemonState;
  port?: number;
  pid?: number;
  message: string;
}

export interface DaemonStatusOptions {
  /** Defaults to the daemon's own location (see getPortFilePath). */
  portFile?: string;
  /** Bound on the whole /health exchange, connect included. */
  timeoutMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 16 * 1024;
const START_HINT = 'Start it with `clipcmd start`.';

/**
 * Mirrors the daemon's resolution: $CLIPCMD_CONFIG_DIR, else ~/.config/clipcmd.
 * Read on every call so a changed environment is picked up.
 */
export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLIPCMD_CONFIG_DIR;
  if (override && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.config', 'clipcmd');
}

export function getPortFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), 'port');
}

/** Parses `{port}` or `{port}:{pid}`; undefined for anything malformed. */
export function parsePortFile(content: string): { port: number; pid?: number } | undefined {
  const match = /^(\d{1,5})(?::(\d{1,10}))?$/.exec(content.replace(/^﻿/, '').trim());
  if (!match) return undefined;

  const port = Number(match[1]);
  if (port < 1 || port > 65535) return undefined;

  const pid = match[2] === undefined ? undefined : Number(match[2]);
  return { port, pid: pid !== undefined && pid > 0 ? pid : undefined };
}

export type PortFileRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string }
  | { kind: 'invalid' }
  | { kind: 'ok'; port: number; pid?: number };

/** Reads the port file without ever throwing. */
export function readPortFile(file: string = getPortFilePath()): PortFileRead {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
  const info = parsePortFile(content);
  return info ? { kind: 'ok', ...info } : { kind: 'invalid' };
}

/** Port and pid of the registered daemon, or undefined if none is registered. */
export function getDaemonPortInfo(file: string = getPortFilePath()): { port: number; pid?: number } | undefined {
  const read = readPortFile(file);
  return read.kind === 'ok' ? { port: read.port, pid: read.pid } : undefined;
}

/** True if a process with this pid exists (EPERM: exists, owned by someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type HealthResult =
  | { kind: 'ok' }
  | { kind: 'unreachable' }
  | { kind: 'timeout' }
  | { kind: 'unexpected'; statusCode: number };

/**
 * GET http://127.0.0.1:{port}/health. Resolves exactly once and never rejects.
 * Only a 200 with body {"status":"ok"} counts as a clipcmd daemon, so another
 * program that took over the port is not mistaken for it.
 */
export function checkHealth(port: number, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<HealthResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HealthResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    };

    const req = http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finish({ kind: 'unexpected', statusCode: res.statusCode ?? 0 });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        let ok = false;
        if (statusCode === 200) {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            ok = typeof body === 'object' && body !== null && (body as { status?: unknown }).status === 'ok';
          } catch {
            ok = false;
          }
        }
        finish(ok ? { kind: 'ok' } : { kind: 'unexpected', statusCode });
      });
      res.on('error', () => finish({ kind: 'unreachable' }));
      // Closed without 'end' (connection dropped mid-body); no-op after 'end'
      res.on('close', () => finish({ kind: 'unreachable' }));
    });

    // One deadline for connect + response. (Windows takes ~2s to refuse a
    // connection to a closed loopback port, so a socket idle timeout alone
    // would report a dead daemon as a "timeout".)
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    req.on('error', () => finish({ kind: 'unreachable' }));
  });
}

function pidSuffix(pid: number | undefined): string {
  return pid !== undefined ? ` (PID ${pid})` : '';
}

/**
 * Determines whether the clipcmd daemon is running. Never throws.
 */
export async function getDaemonStatus(options: DaemonStatusOptions = {}): Promise<DaemonStatus> {
  const portFile = options.portFile ?? getPortFilePath();
  const alive = options.isProcessAlive ?? isProcessAlive;
  const read = readPortFile(portFile);

  switch (read.kind) {
    case 'missing':
      return {
        available: false,
        state: 'not-running',
        message: `clipcmd daemon is not running. ${START_HINT}`,
      };
    case 'unreadable':
      return {
        available: false,
        state: 'invalid-port-file',
        message: `Cannot read the clipcmd port file ${portFile}: ${read.error}`,
      };
    case 'invalid':
      return {
        available: false,
        state: 'invalid-port-file',
        message: `The clipcmd port file ${portFile} is invalid. ${START_HINT}`,
      };
  }

  const { port, pid } = read;

  // A dead pid means a crashed daemon: answer instantly instead of waiting
  // for the connection to be refused.
  if (pid !== undefined && !alive(pid)) {
    return {
      available: false,
      state: 'stale',
      port,
      pid,
      message: `clipcmd daemon is not running (PID ${pid} from its port file has exited). ${START_HINT}`,
    };
  }

  const health = await checkHealth(port, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  switch (health.kind) {
    case 'ok':
      return {
        available: true,
        state: 'running',
        port,
        pid,
        message: `clipcmd daemon is running on port ${port}${pidSuffix(pid)}.`,
      };
    case 'unreachable':
      return {
        available: false,
        state: 'unreachable',
        port,
        pid,
        message: `clipcmd daemon${pidSuffix(pid)} is not responding on port ${port}. ${START_HINT}`,
      };
    case 'timeout':
      return {
        available: false,
        state: 'timeout',
        port,
        pid,
        message: `clipcmd daemon health check timed out on port ${port}.`,
      };
    case 'unexpected':
      return {
        available: false,
        state: 'not-clipcmd',
        port,
        pid,
        message: `Port ${port} is answering, but not as a clipcmd daemon (HTTP ${health.statusCode}). ${START_HINT}`,
      };
  }
}
