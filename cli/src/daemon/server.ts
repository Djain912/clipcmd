import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RingBuffer, Block } from './ringBuffer';
import { MultiSelectQueue } from './multiSelectQueue';
import { CaptureSource, isValidSessionId } from './capture';
import { ClipboardWriter } from './clipboard';
import { buildButtonsString, LinkScheme } from './osc8';
import type { ButtonLinks } from '../shared/windowsShortcuts';
import { removePortFileIfOwned, writePortFile } from '../config/portFile';

/** Session used by hooks that do not send a `sid` parameter. */
export const DEFAULT_SESSION_ID = 'default';

/** How many ports above the preferred one to try before giving up (Requirement 1.2). */
const PORT_SCAN_RANGE = 10;

/** A VS Code window counts as present this long after its last /client call. */
const CLIENT_TTL_MS = 5 * 60 * 1000;

/** /output bodies larger than this are rejected. */
const MAX_OUTPUT_BODY_BYTES = 16 * 1024 * 1024;

type RouteHandler = (
  query: URLSearchParams,
  res: http.ServerResponse,
  req: http.IncomingMessage
) => Promise<void> | void;

class BadRequestError extends Error {}

export interface DaemonServerOptions {
  /** Interface to bind. Defaults to the IPv4 loopback so the daemon is never reachable from the network. */
  host?: string;
  /** Write the Port_File after binding (default true). */
  writePortFile?: boolean;
  /** Receives operational errors (Requirement 1.7). */
  log?: (message: string) => void;
  /** Called after /shutdown has closed the server. */
  onShutdown?: () => void;
  /** Cap on concurrently in-progress sessions; the oldest is finalized when exceeded. */
  maxActiveSessions?: number;
  /** Link style for the buttons, decided per command (default 'http'). */
  linkScheme?: () => LinkScheme;
  /** Output kept per block when it arrives via /output. */
  maxOutputBytes?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Button shortcuts (see shared/windowsShortcuts.ts); Windows only. */
  buttonLinks?: ButtonLinks;
  /** A how-to-click tip for a session's first buttons, or undefined for none. */
  clickTip?: () => string | undefined;
  /** Confirms a successful click to the user ("Copied command"); see shared/copyFeedback.ts. */
  onCopied?: (message: string) => void;
}

/** Formats one block as `$ {command}\n{output}`. */
function commandWithOutput(block: Block): string {
  return `$ ${block.command}\n${block.output}`;
}

export class DaemonServer {
  private server: http.Server | null = null;
  private port: number = 0;

  /**
   * In-progress Blocks keyed by shell session. Each terminal runs its own
   * /start → /end cycle, so a single shared slot would let one terminal
   * finalize another's command. Map order is start order (oldest first).
   */
  private readonly currentBlocks = new Map<string, Block>();

  /** Sessions that were already told how to enable output capture. */
  private readonly hintedSessions = new Set<string>();

  /** Sessions that already got their first buttons (and maybe the click tip). */
  private readonly tippedSessions = new Set<string>();

  /** When a VS Code window running the clipcmd extension last checked in. */
  private vscodeSeenAt = -Infinity;

  private readonly routes: Record<string, RouteHandler> = {
    '/start': (q, r) => this.handleStart(q, r),
    '/end': (q, r) => this.handleEnd(q, r),
    '/copy': (q, r, req) => this.handleCopy(q, r, req),
    '/select': (q, r, req) => this.handleSelect(q, r, req),
    '/copy-selected': (q, r, req) => this.handleCopySelected(q, r, req),
    '/output': (q, r, req) => this.handleOutput(q, r, req),
    '/client': (q, r) => this.handleClient(q, r),
    '/health': (q, r) => this.handleHealth(q, r),
    '/shutdown': (q, r) => this.handleShutdown(q, r),
  };

  private readonly host: string;
  private readonly shouldWritePortFile: boolean;
  private readonly log: (message: string) => void;
  private readonly onShutdown: () => void;
  private readonly maxActiveSessions: number;
  private readonly linkScheme: () => LinkScheme;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private readonly buttonLinks: ButtonLinks | undefined;
  private readonly clickTip: () => string | undefined;
  private readonly onCopied: (message: string) => void;

  constructor(
    private readonly ringBuffer: RingBuffer,
    private readonly multiSelectQueue: MultiSelectQueue,
    private readonly capture: CaptureSource,
    private readonly clipboard: ClipboardWriter,
    private readonly preferredPort: number,
    options: DaemonServerOptions = {}
  ) {
    this.host = options.host ?? '127.0.0.1';
    this.shouldWritePortFile = options.writePortFile ?? true;
    this.log = options.log ?? (() => {});
    this.onShutdown = options.onShutdown ?? (() => {});
    this.maxActiveSessions = options.maxActiveSessions ?? 64;
    this.linkScheme = options.linkScheme ?? (() => 'http');
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.buttonLinks = options.buttonLinks;
    this.clickTip = options.clickTip ?? (() => undefined);
    this.onCopied = options.onCopied ?? (() => {});
  }

  /** Tells the user the click worked; a failing confirmation never fails the copy. */
  private confirm(message: string): void {
    try {
      this.onCopied(message);
    } catch (err) {
      this.log(`Copy confirmation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Starts the HTTP server, scanning from preferredPort up to preferredPort+10
   * for a free port. Writes the active port to Port_File as `{port}:{pid}`.
   * Requirements: 10.1, 1.2, 1.3
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Daemon server is already started');
    }
    const server = http.createServer((req, res) => this.handleRequest(req, res));

    const lastPort = Math.min(this.preferredPort + PORT_SCAN_RANGE, 65535);
    let lastError: unknown;
    for (let candidate = this.preferredPort; candidate <= lastPort; candidate++) {
      try {
        await listen(server, candidate, this.host);
        this.port = (server.address() as AddressInfo).port;
        break;
      } catch (err) {
        lastError = err;
        const code = (err as NodeJS.ErrnoException).code;
        // EACCES covers Windows' reserved (Hyper-V) port ranges; anything else is fatal.
        if (code !== 'EADDRINUSE' && code !== 'EACCES') break;
      }
    }

    if (!this.port) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(
        `Failed to bind to any port in range ${this.preferredPort}–${lastPort}: ${reason}`
      );
    }

    this.server = server;
    if (this.shouldWritePortFile) {
      writePortFile(this.port, process.pid);
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      send(res, 400, 'Malformed request URL');
      return;
    }

    const handler = this.routes[url.pathname];
    if (!handler) {
      send(res, 404, 'Not Found');
      return;
    }

    // /output carries a body (captured output can be megabytes); everything else is GET
    const method = url.pathname === '/output' ? 'POST' : 'GET';
    if (req.method !== method) {
      res.setHeader('Allow', method);
      send(res, 405, 'Method Not Allowed');
      return;
    }

    const rejection = this.rejectForeignRequest(req);
    if (rejection) {
      send(res, 403, rejection);
      return;
    }

    for (const key of new Set(url.searchParams.keys())) {
      if (url.searchParams.getAll(key).length > 1) {
        send(res, 400, `Duplicate query parameter: ${key}`);
        return;
      }
    }

    Promise.resolve()
      .then(() => handler(url.searchParams, res, req))
      .catch((err: unknown) => {
        if (err instanceof BadRequestError) {
          send(res, 400, err.message);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Error handling ${url.pathname}: ${message}`);
        send(res, 500, `Internal Server Error: ${message}`);
      });
  }

  /**
   * Web pages can make a browser send requests to 127.0.0.1 (CSRF), and a
   * DNS-rebinding page can even read the responses. Legitimate callers are the
   * shell hooks and the clipcmd:// handler (no browser headers), the VS Code
   * extension, and a user clicking an http button (a top-level navigation
   * with `Sec-Fetch-Site: none`), so reject anything that came from a web page.
   */
  private rejectForeignRequest(req: http.IncomingMessage): string | undefined {
    const host = req.headers.host?.toLowerCase();
    if (host !== undefined) {
      const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
      if (!allowed.includes(host)) {
        return 'Forbidden: unexpected Host header';
      }
    }

    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'none') {
      return 'Forbidden: requests from web pages are not allowed';
    }

    if (req.headers.origin !== undefined) {
      return 'Forbidden: cross-origin requests are not allowed';
    }

    return undefined;
  }

  /** Reads the optional `sid` parameter identifying the shell session. */
  private sessionId(query: URLSearchParams): string {
    const sid = query.get('sid');
    if (sid === null || sid === '') return DEFAULT_SESSION_ID;
    if (!isValidSessionId(sid)) {
      throw new BadRequestError('Invalid sid: expected 1-64 characters from [A-Za-z0-9_.-]');
    }
    return sid;
  }

  /**
   * /start — create a new in-progress Block for the session. If the session
   * already has one, finalize it first (Requirement 3.6).
   * Requirements: 3.3, 3.6
   */
  private async handleStart(query: URLSearchParams, res: http.ServerResponse): Promise<void> {
    // URLSearchParams has already percent-decoded the values; decoding again
    // would corrupt commands containing '%' (e.g. `printf '%41'`).
    const cmd = query.get('cmd');
    const pwd = query.get('pwd');

    if (!cmd || !pwd) {
      send(res, 400, 'Missing required query parameters: cmd and pwd');
      return;
    }

    const sid = this.sessionId(query);
    const term = query.get('term') ?? undefined;
    if (term !== undefined && !/^[a-z0-9-]{1,32}$/.test(term)) {
      send(res, 400, 'Invalid term: expected 1-32 characters from [a-z0-9-]');
      return;
    }
    const seq = parseSeq(query.get('seq'));

    if (this.currentBlocks.has(sid)) {
      await this.finalizeSession(sid, null);
    }
    while (this.currentBlocks.size >= this.maxActiveSessions) {
      // Shells that exit mid-command never send /end; don't let them pile up.
      const oldest = this.currentBlocks.keys().next().value as string;
      await this.finalizeSession(oldest, null);
    }

    const block: Block = {
      id: randomUUID(),
      command: cmd,
      pwd,
      timestamp: this.now(),
      exitCode: null,
      output: '',
      inProgress: true,
      sessionId: sid,
      term,
      seq,
    };

    this.capture.startCapture(block.id, sid);
    this.currentBlocks.set(sid, block);

    send(res, 200, 'OK');
  }

  /**
   * /end — finalize the session's in-progress Block and return the buttons
   * in the response body; the shell hook prints them to the terminal.
   * Requirements: 3.4, 6.6
   */
  private async handleEnd(query: URLSearchParams, res: http.ServerResponse): Promise<void> {
    const exitCodeStr = query.get('exitCode');

    if (exitCodeStr === null || exitCodeStr === '') {
      send(res, 400, 'Missing required query parameter: exitCode');
      return;
    }

    if (!/^-?\d{1,10}$/.test(exitCodeStr)) {
      send(res, 400, 'Invalid exitCode: must be an integer');
      return;
    }

    const sid = this.sessionId(query);
    const block = await this.finalizeSession(sid, Number(exitCodeStr));

    // No block in progress (e.g. the daemon restarted mid-command): nothing to show.
    if (!block) {
      send(res, 200, '');
      return;
    }

    const withOutput = this.outputAvailable(block);
    const scheme = this.linkScheme();
    // Windows Terminal cannot open clipcmd:// links, and it cannot always be
    // detected (no WT_SESSION when it is the default terminal and adopts a
    // window started from the Start menu). Buttons are shortcuts everywhere on
    // Windows except VS Code, which opens file:// links as documents.
    const links = this.buttonLinks;
    const wrap =
      scheme === 'clipcmd' && block.term !== 'vscode' && links
        ? (button: string, url: string) => links.urlFor(block.id, button, url) ?? url
        : undefined;
    let body = buildButtonsString(block, this.port, { scheme, withOutput, wrap });
    if (!this.tippedSessions.has(sid)) {
      if (this.tippedSessions.size >= 1024) this.tippedSessions.clear();
      this.tippedSessions.add(sid);
      const tip = this.clickTip();
      if (tip) body += `\x1b[2m${tip}\x1b[0m\n`;
    }
    if (!withOutput && !this.hintedSessions.has(sid)) {
      if (this.hintedSessions.size >= 1024) this.hintedSessions.clear();
      this.hintedSessions.add(sid);
      body += `\x1b[2m${captureHint(block.term)}\x1b[0m\n`;
    }
    send(res, 200, body);
  }

  /**
   * Output is captured when the session runs inside `clipcmd shell`, or when
   * it runs in VS Code's terminal and the clipcmd extension is there to send
   * the output (it arrives via /output right after /end).
   */
  private outputAvailable(block: Block): boolean {
    if (block.sessionId && this.capture.isCapturing?.(block.sessionId)) return true;
    return block.term === 'vscode' && this.now() - this.vscodeSeenAt < CLIENT_TTL_MS;
  }

  /**
   * /copy — write a Block's command, raw output, or both to the clipboard.
   * Requirements: 5.6, 5.7, 5.8, 5.9, 5.10, 7.1–7.4, 9.2
   */
  private async handleCopy(
    query: URLSearchParams,
    res: http.ServerResponse,
    req: http.IncomingMessage
  ): Promise<void> {
    const id = query.get('id');
    const type = query.get('type');

    if (!id || !type) {
      reply(req, res, 400, 'Missing required query parameters: id and type');
      return;
    }

    if (type !== 'cmd' && type !== 'output' && type !== 'both') {
      reply(req, res, 400, 'Invalid type: must be "cmd", "output" or "both"');
      return;
    }

    const block = this.ringBuffer.get(id);
    if (!block) {
      reply(req, res, 404, 'That command is no longer in clipcmd\'s history.');
      return;
    }

    const textToCopy = type === 'cmd' ? block.command : type === 'output' ? block.output : commandWithOutput(block);

    try {
      await this.clipboard.write(textToCopy);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Clipboard write failed: ${message}`);
      reply(req, res, 500, `Clipboard write failed: ${message}`);
      return;
    }
    const what = type === 'cmd' ? 'command' : type === 'output' ? 'output' : 'command and output';
    reply(req, res, 200, `Copied ${what} to clipboard`);
    this.confirm(type === 'cmd' ? 'Copied command' : type === 'output' ? 'Copied output' : 'Copied command + output');
  }

  /**
   * /select — the [+] button. Toggles a Block in the selection and puts the
   * whole selection on the clipboard right away, so collecting several
   * commands needs no separate "copy" step.
   * Requirements: 6.1, 6.2
   */
  private async handleSelect(
    query: URLSearchParams,
    res: http.ServerResponse,
    req: http.IncomingMessage
  ): Promise<void> {
    const id = query.get('id');

    if (!id) {
      reply(req, res, 400, 'Missing required query parameter: id');
      return;
    }

    if (!this.ringBuffer.get(id)) {
      reply(req, res, 404, 'That command is no longer in clipcmd\'s history.');
      return;
    }

    this.multiSelectQueue.toggle(id);
    const added = this.multiSelectQueue.has(id);
    const blocks = this.selectedBlocks();

    if (blocks.length > 0) {
      try {
        await this.clipboard.write(formatSelection(blocks));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Clipboard write failed: ${message}`);
        reply(req, res, 500, `Clipboard write failed: ${message}`);
        return;
      }
    }

    const count = `${blocks.length} command${blocks.length === 1 ? '' : 's'}`;
    reply(req, res, 200, added ? `Added to collection: ${count} copied` : `Removed from collection: ${count} left`);
    this.confirm(added ? `Collected: ${count} copied` : `Removed: ${count} left`);
  }

  /** Selected blocks in chronological order. */
  private selectedBlocks(): Block[] {
    const selected = new Set(this.multiSelectQueue.getAll());
    return this.ringBuffer.getAll().filter((block) => selected.has(block.id));
  }

  /**
   * /copy-selected — copy every selected Block as `$ {command}\n{output}\n\n`
   * in chronological order, then clear the selection.
   * Requirements: 6.3, 6.4, 6.5, 7.5
   */
  private async handleCopySelected(
    _query: URLSearchParams,
    res: http.ServerResponse,
    req: http.IncomingMessage
  ): Promise<void> {
    const blocks = this.selectedBlocks();

    try {
      await this.clipboard.write(formatSelection(blocks));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Clipboard write failed: ${message}`);
      reply(req, res, 500, `Clipboard write failed: ${message}`);
      return;
    }
    this.multiSelectQueue.clear();
    reply(req, res, 200, `Copied ${blocks.length} block${blocks.length === 1 ? '' : 's'} to clipboard`);
    this.confirm(`Copied ${blocks.length} command${blocks.length === 1 ? '' : 's'}`);
  }

  /**
   * POST /output — output captured outside the daemon, as plain text:
   * - `clipcmd shell` sends ?sid=..&seq=.. (the hook's command counter), which
   *   identifies the command exactly, even if it arrives just before /end.
   * - the VS Code extension sends ?sid=..&cmd=.. and the command text is
   *   matched against the most recent commands.
   */
  private async handleOutput(
    query: URLSearchParams,
    res: http.ServerResponse,
    req: http.IncomingMessage
  ): Promise<void> {
    const cmd = query.get('cmd');
    const sid = query.get('sid');
    const seqParam = query.get('seq');
    const seq = parseSeq(seqParam);
    if (sid !== null && !isValidSessionId(sid)) {
      send(res, 400, 'Invalid sid');
      return;
    }
    if (seqParam !== null && (seq === undefined || !sid)) {
      send(res, 400, 'Invalid seq (it also needs sid)');
      return;
    }
    if (!cmd && seq === undefined) {
      send(res, 400, 'Missing required query parameter: cmd or seq');
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_OUTPUT_BODY_BYTES);
    } catch {
      send(res, 413, 'Output too large');
      return;
    }

    const block =
      seq !== undefined ? this.findBlockBySeq(sid as string, seq) : this.findBlockForOutput((cmd as string).trim(), sid);
    if (!block) {
      send(res, 404, 'No matching command');
      return;
    }
    block.output = Buffer.byteLength(body) > this.maxOutputBytes ? tailBytes(body, this.maxOutputBytes) : body;
    block.outputFromClient = true;
    send(res, 200, 'OK');
  }

  /** The session's in-progress or finalized block with this command counter. */
  private findBlockBySeq(sid: string, seq: number): Block | undefined {
    const current = this.currentBlocks.get(sid);
    if (current?.seq === seq) return current;
    return this.ringBuffer
      .getAll()
      .reverse()
      .find((b) => b.sessionId === sid && b.seq === seq);
  }

  /**
   * The newest block with this command: from the same session when the
   * session id matches, otherwise from any VS Code session in the last
   * minute (the terminal's process id is not always the shell's, e.g. Git
   * Bash's launcher).
   */
  private findBlockForOutput(cmd: string, sid: string | null): Block | undefined {
    const blocks = this.ringBuffer.getAll().reverse();
    const matches = (b: Block) => b.command.trim() === cmd;
    if (sid) {
      const own = blocks.find((b) => b.sessionId === sid);
      if (own && matches(own)) return own;
    }
    const cutoff = this.now() - 60000;
    return blocks.find((b) => b.term === 'vscode' && b.timestamp >= cutoff && matches(b));
  }

  /** /client?kind=vscode — the VS Code extension announces itself. */
  private handleClient(query: URLSearchParams, res: http.ServerResponse): void {
    if (query.get('kind') !== 'vscode') {
      send(res, 400, 'Invalid kind');
      return;
    }
    this.vscodeSeenAt = this.now();
    send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json');
  }

  private handleHealth(_query: URLSearchParams, res: http.ServerResponse): void {
    send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json');
  }

  private handleShutdown(_query: URLSearchParams, res: http.ServerResponse): void {
    res.writeHead(200, responseHeaders('text/plain; charset=utf-8'));
    res.end('Shutting down', () => {
      void this.stop().then(() => this.onShutdown());
    });
  }

  /**
   * Finalizes a session's in-progress Block: attaches captured output and the
   * exit code, pushes it to the ring buffer (evicting the oldest if full), and
   * drops any evicted Block from the multi-select queue (Requirement 6.6).
   */
  private async finalizeSession(sid: string, exitCode: number | null): Promise<Block | undefined> {
    const block = this.currentBlocks.get(sid);
    if (!block) return undefined;
    // Remove first so an overlapping request cannot finalize the same Block twice.
    this.currentBlocks.delete(sid);

    let captured = '';
    try {
      captured = await this.capture.endCapture(block.id);
    } catch (err) {
      this.log(`Output capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Rendered text from /output (it can arrive before /end) beats raw bytes
    if (!block.outputFromClient) block.output = captured;
    block.exitCode = exitCode;
    block.inProgress = false;

    const evicted = this.ringBuffer.push(block);
    if (evicted) {
      this.multiSelectQueue.remove(evicted.id);
      this.buttonLinks?.forget(evicted.id);
    }
    return block;
  }

  getPort(): number {
    return this.port;
  }

  /** Stops listening, drops open connections, and removes our Port_File. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Browsers keep idle keep-alive sockets open, which would stall close().
      server.closeAllConnections();
    });
    if (this.shouldWritePortFile) {
      removePortFileIfOwned(process.pid);
    }
  }
}

function parseSeq(value: string | null): number | undefined {
  return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** Selection format (Requirement 7.5): `$ {command}\n{output}\n\n` per block. */
function formatSelection(blocks: Block[]): string {
  return blocks.map((block) => `${commandWithOutput(block)}\n\n`).join('');
}

function captureHint(term: string | undefined): string {
  return term === 'vscode'
    ? 'clipcmd: install the clipcmd VS Code extension to also copy command output here.'
    : 'clipcmd: to also copy command output, run this shell inside `clipcmd shell`.';
}

function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Detach both listeners on either outcome; a failed attempt must not leave
    // a stale 'listening' callback behind for the next port in the scan.
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (err) {
      // listen() throws synchronously for out-of-range ports
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(err);
    }
  });
}

function responseHeaders(contentType: string): http.OutgoingHttpHeaders {
  return {
    'Content-Type': contentType,
    // Every request has a side effect; a cached response would skip the copy.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8'
): void {
  if (res.headersSent) return;
  res.writeHead(status, responseHeaders(contentType));
  res.end(body);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Plain text for scripts; for a browser (an http button was clicked where no
 * clipcmd:// handler is registered) a small page that closes its own tab.
 * Browsers allow window.close() for a tab opened from another app because
 * its history has a single entry.
 */
function reply(req: http.IncomingMessage, res: http.ServerResponse, status: number, message: string): void {
  if (!(req.headers.accept ?? '').includes('text/html')) {
    send(res, status, message);
    return;
  }
  const ok = status < 400;
  const html =
    '<!doctype html><meta charset="utf-8"><title>clipcmd</title>' +
    '<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0">' +
    `<p>${ok ? '&#10003; ' : ''}${escapeHtml(message)}</p>` +
    (ok ? '<script>setTimeout(function(){window.close()},600)</script>' : '');
  send(res, status, html, 'text/html; charset=utf-8');
}
