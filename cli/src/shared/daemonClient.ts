import * as http from 'node:http';
import { isProcessAlive, readPortFile } from '../config/portFile';

export interface HttpResult {
  status: number;
  body: string;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * GET http://127.0.0.1:{port}{path}. Rejects on connection errors and when
 * the whole exchange takes longer than timeoutMs. Uses a fresh socket
 * (no keep-alive agent) so a pending idle socket never delays CLI exit.
 */
export function httpGet(port: number, pathWithQuery: string, timeoutMs = 2000): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: pathWithQuery, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`Request to port ${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** True only if the port answers /health exactly like a clipcmd daemon. */
export async function checkHealth(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const { status, body } = await httpGet(port, '/health', timeoutMs);
    if (status !== 200) return false;
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && (parsed as { status?: unknown }).status === 'ok';
  } catch {
    return false;
  }
}

export type DaemonState =
  /** Port_File present and the daemon answers /health. */
  | { state: 'running'; port: number; pid?: number }
  /** No (valid) Port_File. */
  | { state: 'not-running' }
  /** Port_File left behind by a daemon that is gone. */
  | { state: 'stale'; port: number; pid?: number }
  /** The registered pid is alive but nothing healthy answers on the port. */
  | { state: 'unresponsive'; port: number; pid: number };

/**
 * Classifies the daemon from the Port_File, checking pid liveness first:
 * on Windows a connection to a closed loopback port takes ~2s to fail, so
 * this keeps the common "daemon died" case instant.
 */
export async function getDaemonState(timeoutMs = 2000): Promise<DaemonState> {
  const info = readPortFile();
  if (!info) return { state: 'not-running' };

  const { port, pid } = info;
  if (pid !== undefined && !isProcessAlive(pid)) {
    return { state: 'stale', port, pid };
  }
  if (await checkHealth(port, timeoutMs)) {
    return { state: 'running', port, pid };
  }
  return pid !== undefined ? { state: 'unresponsive', port, pid } : { state: 'stale', port };
}

export function describePid(pid: number | undefined): string {
  return pid !== undefined ? ` (PID ${pid})` : '';
}
