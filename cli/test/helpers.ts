import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Terminal } from '@xterm/headless';
import { FileTailCapture } from '../src/daemon/capture';
import { loadNodePty } from '../src/shared/nodePty';
import type { ClipboardWriter } from '../src/daemon/clipboard';
import { MultiSelectQueue } from '../src/daemon/multiSelectQueue';
import { RingBuffer } from '../src/daemon/ringBuffer';
import { DaemonServer, DaemonServerOptions } from '../src/daemon/server';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const BIN = path.join(REPO_ROOT, 'bin', 'clipcmd.js');

export function makeTempDir(prefix = 'clipcmd-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Clipboard double that records writes instead of touching the real clipboard. */
export class FakeClipboard implements ClipboardWriter {
  writes: string[] = [];
  fail = false;

  async write(text: string): Promise<void> {
    if (this.fail) throw new Error('clipboard unavailable');
    this.writes.push(text);
  }

  get last(): string | undefined {
    return this.writes[this.writes.length - 1];
  }
}

export interface TestDaemon {
  server: DaemonServer;
  ringBuffer: RingBuffer;
  queue: MultiSelectQueue;
  clipboard: FakeClipboard;
  capture: FileTailCapture;
  port: number;
  logs: string[];
  sessionsDir: string;
  stop(): Promise<void>;
}

/**
 * Starts an in-process daemon on an ephemeral port with a fake clipboard.
 * With writePortFile, the Port_File goes to $CLIPCMD_CONFIG_DIR — set it first.
 */
export async function startTestDaemon(
  options: { configDir: string; ringBufferSize?: number } & DaemonServerOptions
): Promise<TestDaemon> {
  const { configDir, ringBufferSize = 200, ...serverOptions } = options;
  const logs: string[] = [];
  const ringBuffer = new RingBuffer(ringBufferSize);
  const queue = new MultiSelectQueue();
  const clipboard = new FakeClipboard();
  const sessionsDir = path.join(configDir, 'sessions');
  const capture = new FileTailCapture({ sessionsDir: () => sessionsDir, settleMs: 5, maxWaitMs: 50 });
  const server = new DaemonServer(ringBuffer, queue, capture, clipboard, 0, {
    writePortFile: false,
    log: (message) => logs.push(message),
    ...serverOptions,
  });
  await server.start();
  return {
    server,
    ringBuffer,
    queue,
    clipboard,
    capture,
    port: server.getPort(),
    logs,
    sessionsDir,
    stop: () => server.stop(),
  };
}

export interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** Raw GET (or other method) against 127.0.0.1 with full control over headers. */
export function request(
  port: number,
  pathWithQuery: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathWithQuery,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Builds a query string with proper encoding. */
export function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** Returns a TCP port that was free a moment ago. */
export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Holds a port open so the daemon has to scan past it. */
export async function occupyPort(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function which(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      // Skip the WSL launcher: C:\Windows\System32\bash.exe is not Git Bash
      if (/\\system32\\/i.test(candidate)) continue;
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Git Bash on Windows, bash elsewhere; CLIPCMD_TEST_BASH overrides. */
export function findBash(): string | undefined {
  if (process.env.CLIPCMD_TEST_BASH) return process.env.CLIPCMD_TEST_BASH;
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ];
    return candidates.find((c) => fs.existsSync(c));
  }
  return which('bash');
}

export function findShell(name: 'zsh' | 'fish'): string | undefined {
  const override = process.env[`CLIPCMD_TEST_${name.toUpperCase()}`];
  return override || which(name);
}

/** Locates VS Code's bash shell-integration script, if VS Code is installed. */
export function findVsCodeBashIntegration(): string | undefined {
  if (process.env.CLIPCMD_TEST_VSCODE_SCRIPT) return process.env.CLIPCMD_TEST_VSCODE_SCRIPT;
  const tail = path.join('resources', 'app', 'out', 'vs', 'workbench', 'contrib', 'terminal', 'common', 'scripts', 'shellIntegration-bash.sh');
  const roots: string[] = [];
  // LOCALAPPDATA is faked during tests (see vitest.config.ts)
  const localAppData = process.env.CLIPCMD_TEST_REAL_LOCALAPPDATA || process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && localAppData) {
    roots.push(path.join(localAppData, 'Programs', 'Microsoft VS Code'));
  } else if (process.platform === 'darwin') {
    roots.push('/Applications/Visual Studio Code.app/Contents');
  } else {
    roots.push('/usr/share/code', '/opt/visual-studio-code');
  }
  for (const root of roots) {
    const direct = path.join(root, tail);
    if (fs.existsSync(direct)) return direct;
    // Newer Windows installs nest resources under a commit-hash directory
    try {
      for (const entry of fs.readdirSync(root)) {
        const nested = path.join(root, entry, tail);
        if (fs.existsSync(nested)) return nested;
      }
    } catch {
      // root missing
    }
  }
  return undefined;
}

export function tryLoadNodePty(): typeof import('node-pty') | undefined {
  try {
    return loadNodePty<typeof import('node-pty')>();
  } catch {
    return undefined;
  }
}

/**
 * Answers the terminal queries a program sends (cursor position, device
 * attributes, ...) the way a real terminal would, using a headless emulator
 * fed with the program's output. fish 4 and PSReadLine wait for these replies
 * on Linux and macOS. Not on Windows, where ConPTY sits in between.
 */
export function answerTerminalQueries(term: import('node-pty').IPty, cols: number, rows: number): () => void {
  if (process.platform === 'win32') return () => undefined;
  const emulator = new Terminal({ cols, rows, allowProposedApi: true });
  const reply = emulator.onData((data) => term.write(data));
  const feed = term.onData((data) => emulator.write(data));
  return () => {
    feed.dispose();
    reply.dispose();
    emulator.dispose();
  };
}

export interface TerminalRun {
  output: string;
  code: number | undefined;
}

/**
 * Runs a program in a pseudo-terminal backed by a headless terminal emulator
 * that answers terminal queries, as a real terminal does (fish 4 waits for
 * the replies before it reads commands). Types each line of `input` (after
 * `ready` appears in the output, if given) and waits for the program to exit.
 */
export async function runInTerminal(
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; input?: string[]; ready?: string; timeoutMs?: number }
): Promise<TerminalRun> {
  const pty = tryLoadNodePty();
  if (!pty) throw new Error('node-pty is not available');
  const { cwd, env, input = [], ready, timeoutMs = 30000 } = options;
  const cols = 120;
  const rows = 30;
  const term = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
  const stopAnswering = answerTerminalQueries(term, cols, rows);
  let output = '';
  let code: number | undefined;
  term.onData((data) => (output += data));
  term.onExit((e) => (code = e.exitCode));
  try {
    if (ready) await waitFor(() => code !== undefined || stripAnsi(output).includes(ready), timeoutMs);
    for (const line of input) if (code === undefined) term.write(`${line}\r`);
    await waitFor(() => code !== undefined, timeoutMs);
  } catch (err) {
    throw withScreen(err, output);
  } finally {
    if (code === undefined) term.kill();
    stopAnswering();
  }
  return { output, code };
}

/** Adds the end of what a terminal showed to an error (to see why a wait timed out). */
export function withScreen(err: unknown, screen: string): Error {
  const tail = stripAnsi(screen).slice(-800);
  return new Error(`${err instanceof Error ? err.message : String(err)}\n--- terminal output (end) ---\n${tail}`);
}

/** Strips OSC 8 links and other escape sequences for readable assertions. */
export function stripAnsi(text: string): string {
  return text
    // OSC ends with BEL or ST (ESC \); Windows' console re-emits links with ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
