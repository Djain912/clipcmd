/**
 * `clipcmd shell [shell]` command
 * Runs a shell inside a node-pty pseudo-terminal and captures each command's
 * output for [COPY OUTPUT] / [COPY BOTH].
 *
 * The session is mirrored into a headless terminal emulator (the one VS Code
 * uses), so the captured text is what the command actually displayed: cursor
 * movement, colors and progress-bar redraws are resolved, wrapped lines are
 * joined. The shell hooks mark where each command's output starts and ends
 * with an invisible escape sequence (OSC 9999;clipcmd;start|end;<seq>), and
 * the text in between is sent to the daemon.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Terminal } from '@xterm/headless';
import type { IMarker } from '@xterm/headless';
import { getSessionsDir } from '../../config/paths';
import { loadNodePty } from '../../shared/nodePty';
import { ensureDaemon, isStoppedByUser } from './start';
import { readPortFile } from '../../config/portFile';
import {
  getWindowsAncestorNames,
  parseShell,
  pickShellFromAncestors,
  SupportedShell,
  UnsupportedShellError,
} from '../../installer/shellDetector';

/** Exit code when the wrapper could not start at all (the PowerShell hook then carries on unwrapped). */
export const EXIT_CANNOT_START = 126;

/** OSC identifier of the hooks' output markers. */
export const MARKER_OSC = 9999;

/** The subset of node-pty's IPty used here. */
export interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): PtyProcess;
}

export interface ShellDeps {
  loadPty: () => PtyModule;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  /** Windows: names of ancestor processes, nearest first (to find the calling PowerShell). */
  ancestors: () => string[];
  /** Delivers a finished command's output to the daemon. */
  sendOutput: (sessionId: string, seq: number, text: string) => void;
  /** Starts the daemon if needed, so no `clipcmd start` is required after a reboot. */
  ensureDaemon: () => Promise<unknown>;
}

const defaultDeps = (): ShellDeps => ({
  loadPty: () => loadNodePty<PtyModule>(),
  stdin: process.stdin,
  stdout: process.stdout,
  env: process.env,
  platform: process.platform,
  cwd: process.cwd(),
  ancestors: getWindowsAncestorNames,
  sendOutput: postOutput,
  ensureDaemon: async () => (isStoppedByUser() ? undefined : ensureDaemon(3000)),
});

/**
 * Picks the shell to launch: an explicit argument, then SHELL, then (Windows)
 * the shell clipcmd was started from, then the system default. node-pty on
 * Windows mangles backslashes in the executable path (`C:\Program Files\...`
 * becomes `C:Program Files...`), so Windows paths use forward slashes.
 */
export function resolveShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, detected?: SupportedShell): string {
  if (platform === 'win32') {
    const fromDetected =
      detected === 'powershell'
        ? 'powershell.exe'
        : detected === 'pwsh'
          ? 'pwsh.exe'
          : detected && env.SHELL && parseShell(env.SHELL) === detected
            ? env.SHELL
            : detected
              ? `${detected}.exe`
              : undefined;
    const shell = fromDetected || env.SHELL || env.ComSpec || env.COMSPEC || 'powershell.exe';
    return shell.replace(/\\/g, '/');
  }
  if (detected && !(env.SHELL && parseShell(env.SHELL) === detected)) return detected;
  return env.SHELL || '/bin/sh';
}

/**
 * Arguments for the wrapped shell: PowerShell already showed its banner in the
 * outer console; `login` starts a login shell, like the one being replaced.
 */
export function shellArgs(file: string, login = false): string[] {
  const shell = parseShell(file);
  if (shell === 'powershell' || shell === 'pwsh') return ['-NoLogo'];
  return login && shell ? ['-l'] : [];
}

/** The button line the hooks print after each command (see daemon/osc8.ts). */
const BUTTONS_LINE = /^\[COPY CMD\]( \[COPY OUTPUT\] \[COPY BOTH\])? \[\+\]\s*$/;

/**
 * Text of buffer lines [first, end) as displayed: wrapped rows are joined
 * into one line, trailing spaces trimmed, blank lines at either end dropped.
 * With `skipFirst`, the first (logical) line is left out.
 */
export function extractText(term: Terminal, first: number, end: number, skipFirst = false): string {
  const buffer = term.buffer.normal;
  const lines: string[] = [];
  for (let y = Math.max(0, first); y < end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  if (skipFirst) lines.shift();
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/** Index of the last button line in [first, end), or -1. */
export function findButtonsLine(term: Terminal, first: number, end: number): number {
  const buffer = term.buffer.normal;
  for (let y = end - 1; y >= Math.max(0, first); y--) {
    if (BUTTONS_LINE.test(buffer.getLine(y)?.translateToString(true) ?? '')) return y;
  }
  return -1;
}

interface Capture {
  seq: number;
  marker: IMarker;
  /** The start marker overtook the command line's echo, whose row must be skipped. */
  skipEcho: boolean;
}

/**
 * Cuts each command's output out of the mirrored session.
 *
 * Windows' pseudo-console forwards escape sequences immediately but holds
 * text until its next screen refresh, so the start/end markers can overtake
 * the text around them. The markers therefore only say *when* to look; the
 * output ends at the button line the hook prints after it (text order is
 * always preserved), and a start marker that arrives mid-line means the
 * command's echo has not been drawn yet.
 */
export class OutputCapture {
  private current: Capture | undefined;
  private finishing: { capture: Capture; deadline: number } | undefined;
  private lastData = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly term: Terminal,
    private readonly send: (seq: number, text: string) => void,
    private readonly now: () => number = Date.now,
    /** Wait this long without new data before cutting, so the button line is the last one. */
    private readonly quietMs = 40,
    /** Give up waiting for the button line after this long (e.g. the daemon stopped). */
    private readonly maxWaitMs = 1500
  ) {
    term.parser.registerOscHandler(MARKER_OSC, (data) => this.onMarker(data));
  }

  /** Feed PTY output; `done` runs once it has been parsed. */
  write(data: string, done?: () => void): void {
    this.lastData = this.now();
    this.term.write(data, () => {
      this.check();
      done?.();
    });
  }

  private onMarker(data: string): boolean {
    const [tag, kind, seqText] = data.split(';');
    if (tag !== 'clipcmd') return false;
    const seq = Number(seqText);
    if (kind === 'start') {
      this.flush(true); // a previous command still waiting for its buttons
      this.current?.marker.dispose();
      const buffer = this.term.buffer.normal;
      // undefined while a full-screen app holds the alternate screen
      const marker = this.term.registerMarker(0);
      this.current = marker ? { seq, marker, skipEcho: buffer.cursorX > 0 } : undefined;
    } else if (kind === 'end' && this.current?.seq === seq) {
      this.finishing = { capture: this.current, deadline: this.now() + this.maxWaitMs };
      this.current = undefined;
      this.schedule();
    }
    return true;
  }

  private schedule(): void {
    if (this.timer || !this.finishing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.check();
      this.schedule();
    }, this.quietMs);
  }

  /** Cut the pending command once its button line arrived and output went quiet. */
  check(): void {
    const pending = this.finishing;
    if (!pending) return;
    const quiet = this.now() - this.lastData >= this.quietMs;
    const expired = this.now() >= pending.deadline;
    if (!quiet && !expired) return;
    if (!expired && this.buttonsLine(pending.capture) < 0) return;
    this.flush();
  }

  /**
   * Cut the pending command now with whatever the mirror holds. With
   * `atNextCommand`, the next command's start marker triggered it: the line
   * above the cursor is then that command's prompt and echo.
   */
  flush(atNextCommand = false): void {
    const pending = this.finishing;
    if (!pending) return;
    this.finishing = undefined;
    const { capture } = pending;
    const buffer = this.term.buffer.normal;
    const first = capture.marker.isDisposed || capture.marker.line < 0 ? 0 : capture.marker.line;
    const cursorLine = buffer.baseY + buffer.cursorY;
    const buttons = this.buttonsLine(capture);
    // Without a button line, stop before the prompt (and echo) the cursor is on
    const end = buttons >= 0 ? buttons : atNextCommand && buffer.cursorX === 0 ? cursorLine - 1 : cursorLine;
    const text = extractText(this.term, first, end, capture.skipEcho);
    capture.marker.dispose();
    try {
      this.send(capture.seq, text);
    } catch {
      // Capture is best-effort; never break the interactive session over it.
    }
  }

  private buttonsLine(capture: Capture): number {
    const buffer = this.term.buffer.normal;
    const first = capture.marker.isDisposed || capture.marker.line < 0 ? 0 : capture.marker.line;
    return findButtonsLine(this.term, first, buffer.baseY + buffer.cursorY + 1);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }
}

/** POST the output to the daemon; best-effort, never throws. */
export function postOutput(sessionId: string, seq: number, text: string): void {
  const info = readPortFile();
  if (!info) return;
  const req = http.request(
    {
      host: '127.0.0.1',
      port: info.port,
      method: 'POST',
      path: `/output?sid=${encodeURIComponent(sessionId)}&seq=${seq}`,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      agent: false,
      timeout: 3000,
    },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(text);
}

/** Removes our markers before output reaches the real terminal. */
const MARKER_RE = new RegExp(`\\x1b\\]${MARKER_OSC};clipcmd;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)`, 'g');

export async function run(args: string[], deps: ShellDeps = defaultDeps()): Promise<number> {
  const login = args.includes('--login');
  const shellArg = args.find((arg) => arg !== '--login');
  let requested: SupportedShell | undefined;
  if (shellArg !== undefined) {
    requested = parseShell(shellArg);
    if (!requested) {
      console.error(new UnsupportedShellError(shellArg).message);
      return EXIT_CANNOT_START;
    }
  }

  let nodePty: PtyModule;
  try {
    nodePty = deps.loadPty();
  } catch {
    console.error(
      'node-pty is not installed. To enable PTY mode, reinstall clipcmd so its optional\n' +
        'dependency is built, e.g.:\n  npm install -g clipcmd\n' +
        'or, inside a project checkout:\n  npm install node-pty'
    );
    return EXIT_CANNOT_START;
  }

  // Guard: stdin must be a TTY so we can put it in raw mode
  if (!deps.stdin.isTTY || typeof deps.stdin.setRawMode !== 'function') {
    console.error('clipcmd shell requires an interactive terminal (stdin is not a TTY).');
    return EXIT_CANNOT_START;
  }

  // The hooks need a daemon; start one if this is the first shell since boot.
  // A failure is not fatal: the shell still works, just without buttons.
  try {
    await deps.ensureDaemon();
  } catch {
    // ignore
  }

  // The hooks inside the wrapped shell report this id as `sid`. (The shell's
  // own pid is not usable: under Git Bash it differs from the Windows pid.)
  const sessionId = randomUUID();
  // The session file tells the daemon this session's output is captured.
  const sessionsDir = getSessionsDir();
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${sessionId}.log`);
  fs.writeFileSync(sessionFile, '');

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(deps.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLIPCMD_SESSION = sessionId;

  const cols = deps.stdout.columns || 80;
  const rows = deps.stdout.rows || 24;

  let pty: PtyProcess;
  try {
    // PowerShell sets no SHELL, so on Windows find the shell we were started from
    const detected =
      requested ?? (deps.platform === 'win32' && !deps.env.SHELL ? pickShellFromAncestors(deps.ancestors()) : undefined);
    const file = resolveShell(deps.env, deps.platform, detected);
    pty = nodePty.spawn(file, shellArgs(file, login), { name: 'xterm-256color', cols, rows, cwd: deps.cwd, env });
  } catch (err) {
    fs.rmSync(sessionFile, { force: true });
    console.error(`Failed to start shell: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_CANNOT_START;
  }

  // Mirror of the session, used to read back what each command displayed
  const mirror = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  const capture = new OutputCapture(mirror, (seq, text) => deps.sendOutput(sessionId, seq, text));

  pty.onData((data: string) => {
    deps.stdout.write(data.replace(MARKER_RE, ''));
    capture.write(data);
  });

  // Put stdin in raw mode so all keystrokes pass through unmodified
  deps.stdin.setRawMode(true);
  deps.stdin.resume();

  const onInput = (data: Buffer) => {
    pty.write(data.toString('utf8'));
  };
  deps.stdin.on('data', onInput);

  // Forward terminal resizes (SIGWINCH on POSIX; 'resize' also fires on Windows)
  const onResize = () => {
    const newCols = deps.stdout.columns || 80;
    const newRows = deps.stdout.rows || 24;
    pty.resize(newCols, newRows);
    mirror.resize(newCols, newRows);
  };
  deps.stdout.on('resize', onResize);

  return new Promise<number>((resolve) => {
    pty.onExit(({ exitCode }) => {
      deps.stdout.off('resize', onResize);
      deps.stdin.off('data', onInput);
      try {
        deps.stdin.setRawMode(false);
      } catch {
        // Ignore errors during cleanup
      }
      deps.stdin.pause();
      capture.dispose();
      mirror.dispose();
      fs.rmSync(sessionFile, { force: true });
      resolve(exitCode);
    });
  });
}
