/**
 * The hooks start the daemon when it is missing (first shell after a reboot,
 * a crashed daemon) and move interactive sessions into `clipcmd shell` for
 * output capture. A fake `clipcmd` first on PATH records how it was called,
 * so these tests never start real daemons or wrappers.
 *
 * Runs for every shell found here: bash (Git Bash on Windows), zsh and fish
 * (CI on Linux/macOS), and PowerShell.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePortFile } from '../../src/config/portFile';
import {
  answerTerminalQueries,
  findBash,
  findShell,
  freePort,
  makeTempDir,
  removeDir,
  REPO_ROOT,
  runInTerminal,
  startTestDaemon,
  stripAnsi,
  TestDaemon,
  tryLoadNodePty,
  waitFor,
  withScreen,
} from '../helpers';

const pty = tryLoadNodePty();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir: string; // CLIPCMD_CONFIG_DIR
let home: string;
let bin: string; // holds the fake clipcmd
let daemon: TestDaemon;

/** A fake `clipcmd`: appends its arguments to bin/calls.txt, exits with CLIPCMD_FAKE_EXIT. */
function writeFakeClipcmd(): void {
  fs.mkdirSync(bin, { recursive: true });
  const sh = path.join(bin, 'clipcmd');
  fs.writeFileSync(sh, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$(dirname "$0")/calls.txt"\nexit "${CLIPCMD_FAKE_EXIT:-0}"\n');
  fs.chmodSync(sh, 0o755);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'clipcmd.cmd'), '@echo %*>> "%~dp0calls.txt"\r\n@exit /b %CLIPCMD_FAKE_EXIT%\r\n');
  }
}

function calls(): string[] {
  try {
    return fs
      .readFileSync(path.join(bin, 'calls.txt'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const AUTOSTART = 'start --auto --quiet';
const autostarts = () => calls().filter((c) => c === AUTOSTART).length;

/** Environment for the shell under test; undefined values are removed. */
function shellEnv(extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLIPCMD_CONFIG_DIR: dir,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CLIPCMD_AUTOSTART: undefined, // on, as for users (vitest.config.ts turns it off)
    CLIPCMD_AUTOSHELL: '0',
    CLIPCMD_FAKE_EXIT: '0',
    // Whatever terminal runs the tests must not influence the hooks
    TERM_PROGRAM: undefined,
    SSH_CONNECTION: undefined,
    INSIDE_EMACS: undefined,
    CLIPCMD_SESSION: undefined,
    ...extra,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env as Record<string, string>;
}

function registerDaemon(pid = process.pid): void {
  writePortFile(daemon.port, pid, path.join(dir, 'port'));
}

async function registerDeadDaemon(): Promise<void> {
  const exited = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => exited.on('exit', resolve));
  writePortFile(await freePort(), exited.pid!, path.join(dir, 'port'));
}

beforeEach(async () => {
  dir = makeTempDir('clipcmd-auto-cfg-');
  home = makeTempDir('clipcmd-auto-home-');
  bin = path.join(home, 'bin');
  writeFakeClipcmd();
  daemon = await startTestDaemon({ configDir: dir });
});

afterEach(async () => {
  await daemon.stop();
  removeDir(dir);
  removeDir(home);
});

// ------------------------------------------------------------ bash, zsh, fish

const POSIX_SHELLS = [
  { name: 'bash', bin: findBash(), hook: 'bash.sh', rc: '.bashrc', loginRc: '.bash_profile' },
  { name: 'zsh', bin: findShell('zsh'), hook: 'zsh.sh', rc: '.zshrc', loginRc: '.zshrc' },
  { name: 'fish', bin: findShell('fish'), hook: 'fish.fish', rc: path.join('.config', 'fish', 'config.fish'), loginRc: path.join('.config', 'fish', 'config.fish') },
] as const;

for (const shell of POSIX_SHELLS) {
  describe.skipIf(!shell.bin)(`${shell.name} hook: daemon auto-start and auto-shell`, () => {
    const HOOK = fs.readFileSync(path.join(REPO_ROOT, 'hooks', shell.hook), 'utf8');

    // fish only reads commands interactively (firing its events) from a
    // terminal. In a terminal, commands are typed once a known prompt shows
    // (zsh drops what was typed before).
    const isFish = shell.name === 'fish';
    const READY = 'READY>';
    const PROMPT = isFish ? "function fish_prompt; printf 'READY> '; end\n" : "PS1='READY> '\n";

    function writeRc(file: string = shell.rc): void {
      const rc = path.join(home, file);
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      fs.writeFileSync(rc, PROMPT + HOOK);
      // Only our rc: system zsh files may prompt (e.g. compinit about insecure directories)
      if (shell.name === 'zsh') fs.writeFileSync(path.join(home, '.zshenv'), 'unsetopt GLOBAL_RCS\n');
    }

    /** Commands the daemon recorded, without the harness's final `exit` (fish records it). */
    const recorded = () => daemon.ringBuffer.getAll().map((b) => b.command).filter((c) => c !== 'exit');

    function env(extra: Record<string, string | undefined> = {}): Record<string, string> {
      return shellEnv({
        HOME: home,
        ZDOTDIR: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        HISTFILE: path.join(home, '.history'),
        PS1: '$ ',
        PROMPT_COMMAND: '',
        ...extra,
      });
    }

    const args = (login = false) =>
      shell.name === 'bash' ? (login ? ['-l', '-i'] : ['--rcfile', path.join(home, shell.rc), '-i']) : login ? ['-l', '-i'] : ['-i'];

    /**
     * Interactive shell running `script`: from a pipe (no TTY), except fish,
     * which gets a terminal unless `tty` is false.
     */
    async function run(
      script: string,
      extra: Record<string, string | undefined> = {},
      { tty = isFish }: { tty?: boolean } = {}
    ): Promise<{ out: string; code: number | null | undefined }> {
      writeRc();
      if (tty) {
        const input = [...script.split('\n').filter((line) => line !== ''), 'exit'];
        const { output, code } = await runInTerminal(shell.bin as string, args(), { cwd: home, env: env(extra), input, ready: READY });
        return { out: stripAnsi(output), code };
      }
      return new Promise((resolve, reject) => {
        const child = spawn(shell.bin as string, args(), { cwd: home, env: env(extra) });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', (code) => resolve({ out, code }));
        child.stdin.end(`${script}\nexit\n`);
      });
    }

    it('starts a missing daemon in the background, once', async () => {
      const { code } = await run('echo a\necho b\necho c');
      expect(code).toBe(0);
      await waitFor(() => autostarts() === 1, 10000);
      await sleep(300);
      expect(calls()).toEqual([AUTOSTART]);
    });

    it('never starts it after `clipcmd stop`, or with CLIPCMD_AUTOSTART=0', async () => {
      fs.writeFileSync(path.join(dir, 'stopped'), '');
      await run('echo a\necho b');
      fs.rmSync(path.join(dir, 'stopped'));
      await run('echo a\necho b', { CLIPCMD_AUTOSTART: '0' });
      await sleep(1000);
      expect(calls()).toEqual([]);
    });

    it('does not start one while the daemon answers', async () => {
      registerDaemon();
      await run('echo a\necho b');
      await sleep(1000);
      expect(calls()).toEqual([]);
      expect(recorded()).toEqual(['echo a', 'echo b']);
    });

    it('restarts a daemon that stopped answering', async () => {
      writePortFile(await freePort(), process.pid, path.join(dir, 'port')); // alive pid, nothing listening
      await run('echo a\necho b\necho c');
      await waitFor(() => autostarts() === 1, 10000);
      await sleep(300);
      expect(autostarts()).toBe(1);
    });

    // Under Git Bash the port file holds a Windows pid, which bash cannot check
    it.skipIf(process.platform === 'win32')('starts one at shell start when the registered daemon is dead (after a reboot)', async () => {
      await registerDeadDaemon();
      await run('');
      await waitFor(() => autostarts() === 1, 10000);
    });

    it(`CLIPCMD_AUTOSHELL=1 continues the session in \`clipcmd shell ${shell.name}\` and exits with its code`, async () => {
      registerDaemon();
      const { out, code } = await run('echo SHOULD-NOT-RUN', { CLIPCMD_AUTOSHELL: '1', CLIPCMD_FAKE_EXIT: '5' });
      expect(code).toBe(5);
      expect(calls()).toEqual([`shell ${shell.name}`]);
      expect(out).not.toContain('SHOULD-NOT-RUN');
      expect(recorded()).toEqual([]);
    });

    it('carries on in the same session when `clipcmd shell` cannot start (exit 126)', async () => {
      registerDaemon();
      const { out, code } = await run("echo 'it ran'", { CLIPCMD_AUTOSHELL: '1', CLIPCMD_FAKE_EXIT: '126' });
      expect(code).toBe(0);
      expect(calls()).toEqual([`shell ${shell.name}`]);
      expect(out).toContain('it ran');
      expect(recorded()).toEqual(["echo 'it ran'"]);
    });

    it('never wraps inside `clipcmd shell` or VS Code, or without a terminal', async () => {
      registerDaemon();
      await run('true', { CLIPCMD_AUTOSHELL: '1', CLIPCMD_SESSION: 'already-wrapped', CLIPCMD_FAKE_EXIT: '5' });
      await run('true', { CLIPCMD_AUTOSHELL: '1', TERM_PROGRAM: 'vscode', CLIPCMD_FAKE_EXIT: '5' });
      await run('true', { CLIPCMD_AUTOSHELL: undefined, CLIPCMD_FAKE_EXIT: '5' }, { tty: false });
      expect(calls()).toEqual([]);
    });

    describe.skipIf(!pty)('in a terminal', () => {
      /** Starts the shell in a pseudo-terminal and types `exit 3`. */
      async function startInTerminal(extra: Record<string, string | undefined>, login = false) {
        const { output, code } = await runInTerminal(shell.bin as string, args(login), {
          cwd: home,
          env: env(extra),
          input: ['exit 3'],
          ready: READY,
        });
        return { code, screen: stripAnsi(output) };
      }

      it('wraps interactive sessions by default, and exits with the wrapper', async () => {
        registerDaemon();
        writeRc();
        const { code } = await startInTerminal({ CLIPCMD_AUTOSHELL: undefined, CLIPCMD_FAKE_EXIT: '5' });
        expect(calls()).toEqual([`shell ${shell.name}`]);
        expect(code).toBe(5);
      });

      it('passes --login for login shells', async () => {
        registerDaemon();
        writeRc(shell.loginRc);
        await startInTerminal({ CLIPCMD_AUTOSHELL: undefined, CLIPCMD_FAKE_EXIT: '5' }, true);
        expect(calls()).toEqual([`shell ${shell.name} --login`]);
      });

      it('does not wrap with "autoShell": false in config.json, or over SSH', async () => {
        registerDaemon();
        writeRc();
        fs.writeFileSync(path.join(dir, 'config.json'), '{\n  "port": 9666,\n  "autoShell": false\n}\n');
        expect((await startInTerminal({ CLIPCMD_AUTOSHELL: undefined, CLIPCMD_FAKE_EXIT: '5' })).code).toBe(3);
        fs.rmSync(path.join(dir, 'config.json'));
        const ssh = await startInTerminal({ CLIPCMD_AUTOSHELL: undefined, SSH_CONNECTION: '10.0.0.1 5555 10.0.0.2 22', CLIPCMD_FAKE_EXIT: '5' });
        expect(ssh.code).toBe(3);
        expect(calls()).toEqual([]);
      });
    });
  });
}

// ------------------------------------------------------------------ PowerShell

const PS_EXE = [
  process.platform === 'win32' ? 'powershell.exe' : undefined,
  process.env.CLIPCMD_TEST_PWSH || (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'),
].find((exe) => {
  if (!exe) return false;
  const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-Command', '0'], { windowsHide: true, timeout: 30000 });
  return r.status === 0;
}) as string | undefined;

describe.skipIf(!pty || !PS_EXE)(`PowerShell hook: daemon auto-start (${PS_EXE})`, () => {
  const HOOK = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'powershell.ps1'), 'latin1');
  const PROMPT = "function global:prompt { 'READY> ' }\n";

  /** Starts PowerShell with the hook, runs `commands`, and exits. */
  async function runPs(commands: string[], extra: Record<string, string | undefined> = {}): Promise<void> {
    const profile = path.join(home, 'profile.ps1');
    fs.writeFileSync(profile, PROMPT + HOOK, 'latin1');
    const term = pty!.spawn(PS_EXE!, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${profile}'`], {
      name: 'xterm-256color',
      cols: 150,
      rows: 40,
      cwd: home,
      env: shellEnv(extra),
    });
    let screen = '';
    let exited = false;
    term.onData((d) => (screen += d));
    term.onExit(() => (exited = true));
    const stopAnswering = answerTerminalQueries(term, 150, 40);
    const prompts = () => stripAnsi(screen).split('READY>').length - 1;
    try {
      await waitFor(() => prompts() >= 1, 30000);
      for (const command of commands) {
        const before = prompts();
        term.write(`${command}\r`);
        await waitFor(() => prompts() > before, 20000);
      }
      term.write('exit\r');
      await waitFor(() => exited, 15000);
    } catch (err) {
      throw withScreen(err, screen);
    } finally {
      if (!exited) term.kill();
      stopAnswering();
    }
  }

  it('starts a missing daemon in the background, once', async () => {
    await runPs(['Write-Output a', 'Write-Output b']);
    await waitFor(() => autostarts() === 1, 15000);
    await sleep(500);
    expect(calls()).toEqual([AUTOSTART]);
  }, 60000);

  it('starts one at shell start when the registered daemon is dead (after a reboot)', async () => {
    await registerDeadDaemon();
    await runPs([]);
    await waitFor(() => autostarts() === 1, 15000);
  }, 60000);

  it('restarts a daemon that stopped answering', async () => {
    writePortFile(await freePort(), process.pid, path.join(dir, 'port'));
    await runPs(['Write-Output a', 'Write-Output b']);
    await waitFor(() => autostarts() === 1, 15000);
    await sleep(500);
    expect(autostarts()).toBe(1);
  }, 60000);

  it('never starts it after `clipcmd stop`, with CLIPCMD_AUTOSTART=0, or while the daemon answers', async () => {
    fs.writeFileSync(path.join(dir, 'stopped'), '');
    await runPs(['Write-Output a']);
    fs.rmSync(path.join(dir, 'stopped'));
    await runPs(['Write-Output a'], { CLIPCMD_AUTOSTART: '0' });
    registerDaemon();
    await runPs(['Write-Output a']);
    await sleep(1000);
    expect(calls()).toEqual([]);
    expect(daemon.ringBuffer.size).toBe(1);
  }, 90000);
});
