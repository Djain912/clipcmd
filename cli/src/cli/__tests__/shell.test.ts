import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_CANNOT_START,
  extractText,
  findButtonsLine,
  OutputCapture,
  PtyModule,
  PtyProcess,
  resolveShell,
  run,
  shellArgs,
  ShellDeps,
} from '../commands/shell';
import { makeTempDir, removeDir, waitFor } from '../../../test/helpers';

const ESC = '\x1b';
const BEL = '\x07';
const mark = (kind: 'start' | 'end', seq: number) => `${ESC}]9999;clipcmd;${kind};${seq}${BEL}`;
/** What the daemon prints after a command (visible text of the OSC 8 buttons). */
const BUTTONS = `${ESC}]8;;clipcmd://copy?id=1&type=cmd${BEL}[COPY CMD]${ESC}]8;;${BEL} ${ESC}]8;;clipcmd://copy?id=1&type=output${BEL}[COPY OUTPUT]${ESC}]8;;${BEL} ${ESC}]8;;clipcmd://copy?id=1&type=both${BEL}[COPY BOTH]${ESC}]8;;${BEL} ${ESC}]8;;clipcmd://select?id=1${BEL}[+]${ESC}]8;;${BEL}\r\n`;

class FakePty implements PtyProcess {
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  private dataListener: (data: string) => void = () => {};
  private exitListener: (e: { exitCode: number }) => void = () => {};
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number }) => void) {
    this.exitListener = listener;
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  emitData(data: string) {
    this.dataListener(data);
  }
  exit(code: number) {
    this.exitListener({ exitCode: code });
  }
}

function fakeStdin(isTTY = true) {
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.isTTY = isTTY;
  stdin.rawModes = [] as boolean[];
  stdin.setRawMode = (mode: boolean) => (stdin.rawModes as boolean[]).push(mode);
  stdin.resume = vi.fn();
  stdin.pause = vi.fn();
  return stdin;
}

function fakeStdout() {
  const stdout = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.chunks = [] as string[];
  stdout.write = (chunk: string) => (stdout.chunks as string[]).push(chunk);
  return stdout;
}

/** Writes to a headless terminal and resolves once parsed. */
function feed(capture: OutputCapture, data: string): Promise<void> {
  return new Promise((resolve) => capture.write(data, resolve));
}

describe('OutputCapture (cutting command output out of the mirrored session)', () => {
  let term: Terminal;
  let sent: Array<[number, string]>;
  let capture: OutputCapture;

  beforeEach(() => {
    term = new Terminal({ cols: 40, rows: 6, scrollback: 1000, allowProposedApi: true });
    sent = [];
    capture = new OutputCapture(term, (seq, text) => sent.push([seq, text]), Date.now, 20, 400);
  });
  afterEach(() => term.dispose());

  it('captures the text between start and the button line', async () => {
    await feed(capture, `PS> echo hi\r\n${mark('start', 1)}hello\r\nworld\r\n${mark('end', 1)}${BUTTONS}PS> `);
    await waitFor(() => sent.length === 1, 2000);
    expect(sent).toEqual([[1, 'hello\nworld']]);
  });

  it('handles markers that overtook the text (Windows pseudo-console reordering)', async () => {
    // Both markers arrive before the command echo and output are drawn
    await feed(capture, `PS> ${mark('start', 3)}${mark('end', 3)}`);
    await feed(capture, `echo hi\r\nhello\r\n`);
    await feed(capture, `${BUTTONS}PS> `);
    await waitFor(() => sent.length === 1, 2000);
    expect(sent).toEqual([[3, 'hello']]);
  });

  it('waits for output that is still arriving when the end marker comes', async () => {
    await feed(capture, `PS> x\r\n${mark('start', 1)}${mark('end', 1)}`);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toEqual([]);
    await feed(capture, `late line\r\n${BUTTONS}PS> `);
    await waitFor(() => sent.length === 1, 2000);
    expect(sent).toEqual([[1, 'late line']]);
  });

  it('keeps all output of a command that scrolled far past the screen', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    await feed(capture, `PS> x\r\n${mark('start', 1)}${lines.join('\r\n')}\r\n${mark('end', 1)}${BUTTONS}PS> `);
    await waitFor(() => sent.length === 1, 2000);
    expect(sent[0][1]).toBe(lines.join('\n'));
  });

  it('joins wrapped lines, drops colors, and keeps only the final state of redraws', async () => {
    const long = 'x'.repeat(100); // 40 columns: wraps over three rows
    await feed(
      capture,
      `PS> x\r\n${mark('start', 1)}${long}\r\n${ESC}[31mred${ESC}[0m\r\nprogress 10%\rprogress 100%\r\n${mark('end', 1)}${BUTTONS}PS> `
    );
    await waitFor(() => sent.length === 1, 2000);
    expect(sent[0][1]).toBe(`${long}\nred\nprogress 100%`);
  });

  it('includes a last line without a newline', async () => {
    await feed(capture, `PS> x\r\n${mark('start', 1)}no newline${mark('end', 1)}\r\n${BUTTONS}PS> `);
    await waitFor(() => sent.length === 1, 2000);
    expect(sent[0][1]).toBe('no newline');
  });

  it('gives up waiting for the buttons (daemon stopped) and stops before the prompt', async () => {
    await feed(capture, `PS> x\r\n${mark('start', 1)}out\r\n${mark('end', 1)}PS> `);
    await waitFor(() => sent.length === 1, 3000);
    expect(sent).toEqual([[1, 'out']]);
  });

  it('ignores an end marker for a different command and other OSC 9999 users', async () => {
    await feed(capture, `${ESC}]9999;other;thing${BEL}PS> x\r\n${mark('start', 2)}a\r\n${mark('end', 1)}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([]);
  });

  it('a new command flushes a previous one that never got its buttons', async () => {
    await feed(capture, `PS> x\r\n${mark('start', 1)}first\r\n${mark('end', 1)}PS> y\r\n${mark('start', 2)}`);
    expect(sent).toEqual([[1, 'first']]);
  });

  it('findButtonsLine / extractText helpers', async () => {
    await feed(capture, `a\r\n${BUTTONS}b`);
    expect(findButtonsLine(term, 0, 3)).toBe(1);
    expect(findButtonsLine(term, 2, 3)).toBe(-1);
    expect(extractText(term, 0, 3)).toBe('a\n[COPY CMD] [COPY OUTPUT] [COPY BOTH] [+]\nb');
    expect(extractText(term, 0, 3, true)).toBe('[COPY CMD] [COPY OUTPUT] [COPY BOTH] [+]\nb');
  });
});

describe('clipcmd shell (PTY wrapper)', () => {
  let dir: string;
  const saved = process.env.CLIPCMD_CONFIG_DIR;

  beforeEach(() => {
    dir = makeTempDir();
    process.env.CLIPCMD_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
    removeDir(dir);
    vi.restoreAllMocks();
  });

  function setup(overrides: Partial<ShellDeps> = {}) {
    const pty = new FakePty();
    const spawn = vi.fn((_file: string, _args: string[], _opts: { env: Record<string, string>; cols: number; rows: number }) => pty);
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const sent: Array<[string, number, string]> = [];
    const deps: ShellDeps = {
      loadPty: () => ({ spawn }) as unknown as PtyModule,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: { SHELL: '/bin/zsh', KEEP: 'me' },
      platform: 'linux',
      cwd: dir,
      ancestors: () => [],
      sendOutput: (sid, seq, text) => sent.push([sid, seq, text]),
      ensureDaemon: vi.fn(async () => undefined),
      ...overrides,
    };
    // run() spawns the shell after awaiting ensureDaemon
    const spawned = () => waitFor(() => spawn.mock.calls.length > 0, 2000);
    return { pty, spawn, stdin, stdout, deps, sent, spawned };
  }

  it(`exits ${EXIT_CANNOT_START} with install instructions when node-pty is missing (Req 12.3)`, async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = setup({
      loadPty: () => {
        throw new Error("Cannot find module 'node-pty'");
      },
    });
    expect(await run([], deps)).toBe(EXIT_CANNOT_START);
    expect(err.mock.calls[0][0]).toContain('node-pty is not installed');
  });

  it(`exits ${EXIT_CANNOT_START} when stdin is not a TTY or the shell is unknown`, async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run([], setup({ stdin: fakeStdin(false) as unknown as NodeJS.ReadStream }).deps)).toBe(EXIT_CANNOT_START);
    expect(err.mock.calls[0][0]).toContain('interactive terminal');
    expect(await run(['cmd'], setup().deps)).toBe(EXIT_CANNOT_START);
    expect(err.mock.calls[1][0]).toContain('Unsupported shell');
  });

  it('mirrors the terminal, sends each command output to the daemon, and cleans up', async () => {
    const { pty, spawn, stdin, stdout, deps, sent, spawned } = setup();
    const done = run([], deps);
    await spawned();

    const [file, args, opts] = spawn.mock.calls[0];
    expect(file).toBe('/bin/zsh');
    expect(args).toEqual([]);
    expect(opts.cols).toBe(120);
    expect(opts.rows).toBe(40);
    expect(opts.env.KEEP).toBe('me');
    const sessionId = opts.env.CLIPCMD_SESSION;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // The session file tells the daemon this session's output is captured
    const sessionFile = path.join(dir, 'sessions', `${sessionId}.log`);
    expect(fs.existsSync(sessionFile)).toBe(true);

    pty.emitData(`% ls\r\n${mark('start', 1)}file.txt\r\n${mark('end', 1)}`);
    pty.emitData(`${BUTTONS}% `);
    await waitFor(() => sent.length === 1, 2000);
    expect(sent).toEqual([[sessionId, 1, 'file.txt']]);
    // Markers never reach the real terminal
    expect((stdout.chunks as string[]).join('')).not.toContain(']9999;');
    expect((stdout.chunks as string[]).join('')).toContain('file.txt');

    stdin.emit('data', Buffer.from('ls\r'));
    expect(pty.written).toEqual(['ls\r']);
    expect(stdin.rawModes).toEqual([true]);

    stdout.columns = 90;
    stdout.rows = 20;
    stdout.emit('resize');
    expect(pty.resizes).toEqual([[90, 20]]);

    pty.exit(7);
    expect(await done).toBe(7);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(fs.existsSync(sessionFile)).toBe(false);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdout.listenerCount('resize')).toBe(0);
  });

  it('starts the requested shell, without a second PowerShell banner', async () => {
    const { pty, spawn, deps, spawned } = setup({ platform: 'win32', env: {} });
    const done = run(['powershell'], deps);
    await spawned();
    expect(spawn.mock.calls[0][0]).toBe('powershell.exe');
    expect(spawn.mock.calls[0][1]).toEqual(['-NoLogo']);
    pty.exit(0);
    await done;
  });

  it('reports spawn failures without leaving a session file', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = setup({
      loadPty: () =>
        ({
          spawn: () => {
            throw new Error('File not found');
          },
        }) as unknown as PtyModule,
    });
    expect(await run([], deps)).toBe(EXIT_CANNOT_START);
    expect(err.mock.calls[0][0]).toContain('Failed to start shell: File not found');
    expect(fs.readdirSync(path.join(dir, 'sessions'))).toEqual([]);
  });

  it('passes the detected PowerShell to node-pty on Windows', async () => {
    const { pty, spawn, deps, spawned } = setup({
      platform: 'win32',
      env: { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
      ancestors: () => ['cmd.exe', 'pwsh.exe', 'WindowsTerminal.exe'],
    });
    const done = run([], deps);
    await spawned();
    expect(spawn.mock.calls[0][0]).toBe('pwsh.exe');
    pty.exit(0);
    expect(await done).toBe(0);
  });

  it('starts the daemon before the shell, and still starts the shell if that fails', async () => {
    const order: string[] = [];
    const { pty, spawn, deps, spawned } = setup({
      ensureDaemon: async () => {
        order.push('daemon');
        throw new Error('no daemon');
      },
    });
    spawn.mockImplementation(() => {
      order.push('shell');
      return pty;
    });
    const done = run([], deps);
    await spawned();
    expect(order).toEqual(['daemon', 'shell']);
    pty.exit(0);
    expect(await done).toBe(0);
  });

  it('does not start the daemon when it cannot run the shell', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = setup({ stdin: fakeStdin(false) as unknown as NodeJS.ReadStream });
    expect(await run([], deps)).toBe(EXIT_CANNOT_START);
    expect(deps.ensureDaemon).not.toHaveBeenCalled();
  });

  it('starts a login shell with --login (the hooks pass it for login shells)', async () => {
    const { pty, spawn, deps, spawned } = setup();
    const done = run(['--login', 'zsh'], deps);
    await spawned();
    expect(spawn.mock.calls[0][0]).toBe('/bin/zsh');
    expect(spawn.mock.calls[0][1]).toEqual(['-l']);
    pty.exit(0);
    await done;
  });
});

describe('resolveShell / shellArgs', () => {
  it('uses SHELL, falling back to /bin/sh on POSIX', () => {
    expect(resolveShell({ SHELL: '/usr/bin/fish' }, 'darwin')).toBe('/usr/bin/fish');
    expect(resolveShell({}, 'linux')).toBe('/bin/sh');
    expect(resolveShell({ SHELL: '/bin/bash' }, 'linux', 'zsh')).toBe('zsh');
    expect(resolveShell({ SHELL: '/usr/local/bin/zsh' }, 'linux', 'zsh')).toBe('/usr/local/bin/zsh');
  });

  it('passes forward slashes to node-pty on Windows (it strips backslashes)', () => {
    expect(resolveShell({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' }, 'win32')).toBe(
      'C:/Program Files/Git/bin/bash.exe'
    );
    expect(resolveShell({ ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' }, 'win32')).toBe('C:/WINDOWS/system32/cmd.exe');
    expect(resolveShell({}, 'win32')).toBe('powershell.exe');
  });

  it('prefers the requested or detected shell on Windows', () => {
    const env = { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', SHELL: 'C:\\Git\\bin\\bash.exe' };
    expect(resolveShell(env, 'win32', 'powershell')).toBe('powershell.exe');
    expect(resolveShell(env, 'win32', 'pwsh')).toBe('pwsh.exe');
    expect(resolveShell(env, 'win32', 'bash')).toBe('C:/Git/bin/bash.exe');
  });

  it('suppresses the PowerShell banner only for PowerShell', () => {
    expect(shellArgs('powershell.exe')).toEqual(['-NoLogo']);
    expect(shellArgs('C:/Program Files/PowerShell/7/pwsh.exe')).toEqual(['-NoLogo']);
    expect(shellArgs('/bin/bash')).toEqual([]);
  });

  it('starts login shells with -l, except PowerShell and unknown shells', () => {
    expect(shellArgs('/bin/bash', true)).toEqual(['-l']);
    expect(shellArgs('/usr/bin/fish', true)).toEqual(['-l']);
    expect(shellArgs('powershell.exe', true)).toEqual(['-NoLogo']);
    expect(shellArgs('/bin/sh', true)).toEqual([]);
  });
});
