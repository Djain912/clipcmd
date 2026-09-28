/**
 * Daemon entry point — initializes all components and starts the HTTP server.
 * Task 13.1 — Requirements: 1.6, 1.7, 1.8
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigManager } from '../config/config';
import { getLogFile } from '../config/paths';
import { acquireDaemonLock, releaseDaemonLock } from '../config/daemonLock';
import { isProcessAlive, readPortFile, removePortFileIfOwned } from '../config/portFile';
import { checkHealth } from '../shared/daemonClient';
import { isProtocolHandlerInstalled } from '../installer/protocolHandler';
import { RingBuffer } from './ringBuffer';
import { MultiSelectQueue } from './multiSelectQueue';
import { FileTailCapture } from './capture';
import { ClipboardWriterImpl } from './clipboard';
import { DaemonServer } from './server';

/** daemon.log is rotated to daemon.log.1 at startup once it exceeds this size. */
const MAX_LOG_BYTES = 1024 * 1024;

/**
 * Appends a timestamped line to ~/.config/clipcmd/daemon.log.
 */
function log(msg: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;

  const logFile = getLogFile();
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    // Ignore log write errors
  }
}

function rotateLog(): void {
  const logFile = getLogFile();
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // Missing log file or rename failure — keep appending
  }
}

async function main(): Promise<void> {
  rotateLog();
  log('Daemon starting...');

  // Two quick `clipcmd start`s must not leave two daemons fighting over the Port_File.
  if (!acquireDaemonLock()) {
    log('Another daemon is already running or starting; exiting');
    return;
  }
  // Released on every exit path, including crashes
  process.on('exit', () => releaseDaemonLock());

  // A daemon from an older clipcmd (no lock file) may still be serving
  const existing = readPortFile();
  if (
    existing &&
    existing.pid !== process.pid &&
    (existing.pid === undefined || isProcessAlive(existing.pid)) &&
    (await checkHealth(existing.port, 1000))
  ) {
    log(`Another daemon is already running on port ${existing.port}; exiting`);
    process.exit(0);
  }

  // Load configuration
  const config = ConfigManager.load((warning) => log(`Config warning: ${warning}`));
  log(
    `Loaded config: port=${config.port}, ringBufferSize=${config.ringBufferSize}, ` +
      `maxOutputBytes=${config.maxOutputBytes}, links=${config.links}`
  );

  // Initialize components
  const ringBuffer = new RingBuffer(config.ringBufferSize);
  const multiSelectQueue = new MultiSelectQueue();
  const capture = new FileTailCapture({ maxBytes: config.maxOutputBytes });
  const clipboard = new ClipboardWriterImpl();

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`Daemon stopping (${reason})`);
    await server.stop();
    log('Daemon stopped');
    process.exit(0);
  };

  const server = new DaemonServer(ringBuffer, multiSelectQueue, capture, clipboard, config.port, {
    log,
    onShutdown: () => void shutdown('/shutdown request'),
    maxOutputBytes: config.maxOutputBytes,
    // Checked per command, so `clipcmd init` takes effect without a daemon restart
    linkScheme: () =>
      config.links === 'auto' ? (isProtocolHandlerInstalled() ? 'clipcmd' : 'http') : config.links,
  });

  // Requirement 1.6: release the port and delete the Port_File on termination.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  // Last-resort cleanup for exits that bypass shutdown(); only removes our own file.
  process.on('exit', () => removePortFileIfOwned(process.pid));
  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err.stack ?? err.message}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    process.exit(1);
  });

  await server.start();
  log(`Daemon started successfully on port ${server.getPort()}, PID ${process.pid}`);
}

main().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  log(`Daemon startup failed: ${errorMsg}`);
  console.error(`Daemon startup failed: ${errorMsg}`);
  process.exit(1);
});
