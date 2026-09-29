/**
 * Runs the real hooks/bash.sh inside an interactive bash (Git Bash on Windows)
 * against an in-process daemon with a fake clipboard, then inspects exactly
 * what the daemon recorded. Commands are fed on stdin to `bash -i`, which
 * still runs PROMPT_COMMAND and DEBUG traps like a terminal session.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePortFile } from '../../src/config/portFile';
import {
  findBash,
  findVsCodeBashIntegration,
  freePort,
  makeTempDir,
  removeDir,
  REPO_ROOT,
  startTestDaemon,
  stripAnsi,
  TestDaemon,
} from '../helpers';

const BASH = findBash();
const VSCODE_SCRIPT = findVsCodeBashIntegration();
const HOOK = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'bash.sh'), 'utf8');

interface BashRun {
  output: string;
  code: number | null;
  ms: number;
}

let dir: string;
let home: string;
let daemon: TestDaemon;

function runBash(
  rc: string,
  script: string,
  options: { env?: Record<string, string>; initFile?: string } = {}
): Promise<BashRun> {
  const rcFile = path.join(home, '.bashrc');
  fs.writeFileSync(rcFile, rc);
  const args = options.initFile ? ['--init-file', options.initFile, '-i'] : ['--rcfile', rcFile, '-i'];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(BASH as string, args, {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLIPCMD_CONFIG_DIR: dir,
        HISTFILE: path.join(home, '.bash_history'),
        PS1: '$ ',
        PROMPT_COMMAND: '',
        ...options.env,
      },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ output, code, ms: Date.now() - started }));
    child.stdin.end(`${script}\nexit\n`);
  });
}

const commands = () => daemon.ringBuffer.getAll().map((b) => b.command);
const blocks = () => daemon.ringBuffer.getAll().map((b) => [b.command, b.exitCode]);
const buttonCount = (output: string) => output.split('[COPY CMD]').length - 1;

describe.skipIf(!BASH)('bash hook (end to end)', () => {
  beforeEach(async () => {
    dir = makeTempDir('clipcmd-bash-cfg-');
    home = makeTempDir('clipcmd-bash-home-');
    daemon = await startTestDaemon({ configDir: dir });
    writePortFile(daemon.port, process.pid, path.join(dir, 'port'));
  });
  afterEach(async () => {
    await daemon.stop();
    removeDir(dir);
    removeDir(home);
  });

  it('records each command with its full text and exit code, and prints buttons', async () => {
    const run = await runBash(HOOK, ['echo hello', 'echo one | cat', 'false', 'sh -c "exit 7"'].join('\n'));
    expect(blocks()).toEqual([
      ['echo hello', 0],
      ['echo one | cat', 0],
      ['false', 1],
      ['sh -c "exit 7"', 7],
    ]);
    expect(buttonCount(run.output)).toBe(4);
    // Buttons sit on their own line, not glued to the next prompt. No output
    // capture outside `clipcmd shell`: only [COPY CMD] [+], and a one-time hint.
    expect(stripAnsi(run.output)).toMatch(/\[COPY CMD\] \[\+\]\r?\n/);
    expect(stripAnsi(run.output).split('run this shell inside `clipcmd shell`')).toHaveLength(2);
    expect(daemon.ringBuffer.getAll()[0].pwd).not.toBe('');
  });

  it('ignores empty lines (no phantom blocks)', async () => {
    await runBash(HOOK, ['', 'echo a', '', '', 'echo b', ''].join('\n'));
    expect(commands()).toEqual(['echo a', 'echo b']);
  });

  // (Tabs are not tested here: piped into `bash -i`, readline treats TAB as completion.)
  it('sends special characters and UTF-8 intact (regression: Windows curl code page)', async () => {
    const cmds = ["echo '100% & a=b +c'", "printf '%s\\n' 'x%41y'", "echo 'héllo wörld €'", "echo '日本語 🚀'", 'echo [a] {b} "q"'];
    await runBash(HOOK, cmds.join('\n'));
    expect(commands()).toEqual(cmds);
  });

  it('sends a non-ASCII working directory intact', async () => {
    const sub = path.join(home, 'dír-€');
    fs.mkdirSync(sub);
    await runBash(HOOK, `cd 'dír-€'\necho here`);
    expect(daemon.ringBuffer.getAll()[1].pwd.endsWith('/dír-€')).toBe(true);
  });

  it('records multi-line commands as a whole', async () => {
    await runBash(HOOK, 'for i in 1 2; do\n  echo "n$i"\ndone');
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toContain('for i in 1 2');
    expect(commands()[0]).toContain('echo "n$i"');
  });

  it('keeps $? intact for an existing PROMPT_COMMAND', async () => {
    const run = await runBash(`PROMPT_COMMAND='echo "PC:$?"'\n${HOOK}`, 'false\ntrue\n(exit 42)');
    expect(run.output).toContain('PC:1');
    expect(run.output).toContain('PC:42');
    expect(blocks()).toEqual([
      ['false', 1],
      ['true', 0],
    ]); // a bare subshell `( ... )` never triggers bash's DEBUG trap
  });

  it('works with PROMPT_COMMAND as an array (bash 5.1+)', async () => {
    const rc = `PROMPT_COMMAND=('echo "PCA:$?"')\n${HOOK}`;
    const run = await runBash(rc, 'false\necho x');
    if (run.output.includes('syntax error')) return; // bash < 5.1
    expect(run.output).toContain('PCA:1');
    expect(blocks()).toEqual([
      ['false', 1],
      ['echo x', 0],
    ]);
  });

  it('chains a DEBUG trap set earlier in .bashrc', async () => {
    const rc = `trap 'hits=$((hits+1))' DEBUG\n${HOOK}`;
    const run = await runBash(rc, 'echo "A=$hits"\necho "B=$hits"');
    const a = Number(/A=(\d+)/.exec(run.output)?.[1]);
    const b = Number(/B=(\d+)/.exec(run.output)?.[1]);
    expect(b).toBeGreaterThan(a);
    expect(commands()).toEqual(['echo "A=$hits"', 'echo "B=$hits"']);
  });

  it('sourcing .bashrc twice does not double-register', async () => {
    await runBash(`${HOOK}\n${HOOK}`, `source ${JSON.stringify(path.join(home, '.bashrc').replace(/\\/g, '/'))}\necho once`);
    expect(commands()).toEqual([expect.stringContaining('source'), 'echo once']);
    expect(daemon.ringBuffer.size).toBe(2);
  });

  it('with HISTCONTROL=ignoreboth, records hidden and repeated commands correctly', async () => {
    await runBash(HOOK, ['echo first | cat', ' echo secret', 'echo first | cat'].join('\n'), {
      env: { HISTCONTROL: 'ignoreboth' },
    });
    expect(commands()).toEqual(['echo first | cat', 'echo secret', 'echo first | cat']);
  });

  it('routes output capture through CLIPCMD_SESSION', async () => {
    const sessionFile = path.join(dir, 'sessions', 'my-session.log').replace(/\\/g, '/');
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(sessionFile, 'earlier\n');
    await runBash(HOOK, `printf 'captured\\n' >> '${sessionFile}'`, { env: { CLIPCMD_SESSION: 'my-session' } });
    expect(daemon.ringBuffer.getAll()[0].output).toBe('captured\n');
  });

  it('tells the daemon which terminal it runs in (Windows Terminal needs other links)', async () => {
    await runBash(HOOK, 'echo one', { env: { WT_SESSION: 'wt-1' } });
    await runBash(HOOK, 'echo two', { env: { WT_SESSION: 'wt-1', TERM_PROGRAM: 'vscode' } }); // VS Code started from WT
    await runBash(HOOK, 'echo three');
    expect(daemon.ringBuffer.getAll().map((b) => [b.command, b.term])).toEqual([
      ['echo one', 'wt'],
      ['echo two', 'vscode'],
      ['echo three', undefined],
    ]);
  });

  it('stays silent and fast when no daemon is registered', async () => {
    fs.rmSync(path.join(dir, 'port'));
    const run = await runBash(HOOK, 'echo a\necho b\necho c');
    expect(run.code).toBe(0);
    expect(buttonCount(run.output)).toBe(0);
    expect(stripAnsi(run.output)).not.toMatch(/curl|error|No such file/i);
    expect(daemon.ringBuffer.size).toBe(0);
  });

  it('backs off after the daemon stops answering instead of slowing every command', async () => {
    writePortFile(await freePort(), process.pid, path.join(dir, 'port')); // nothing listens there
    const fast = await runBash('', 'true');
    const run = await runBash(HOOK, Array.from({ length: 6 }, (_, i) => `echo ${i}`).join('\n'));
    expect(buttonCount(run.output)).toBe(0);
    expect(stripAnsi(run.output)).not.toMatch(/curl|error/i);
    // Without back-off each of the 6 commands would wait for the 0.5s connect timeout
    expect(run.ms - fast.ms).toBeLessThan(2500);
  });

  it('only installs in interactive shells', async () => {
    // A script, as when a non-interactive tool sources ~/.bashrc
    const script = path.join(home, 'script.sh');
    fs.writeFileSync(script, `${HOOK}\necho "trap=[$(trap -p DEBUG)]"\n`);
    const child = spawn(BASH as string, [script], {
      env: { ...process.env, CLIPCMD_CONFIG_DIR: dir },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise((r) => child.on('close', r));
    expect(out).toContain('trap=[]');
  });

  describe.skipIf(!VSCODE_SCRIPT)("with VS Code's real bash shell integration", () => {
    /**
     * VS Code's OSC 633 markers: E = command line, C = executed, D = finished
     * (+exit code). The harness's trailing `exit` (E:exit, C) is dropped.
     */
    const markers = (output: string) => {
      const all = [...output.matchAll(/\x1b\]633;([CDE])(?:;([^\x07]*))?\x07|\[COPY CMD\]/g)].map((m) =>
        m[0] === '[COPY CMD]' ? 'BUTTONS' : m[1] === 'E' ? `E:${m[2].replace(/;[^;]*$/, '')}` : m[2] ? `${m[1]}:${m[2]}` : m[1]
      );
      const lastD = all.map((m) => m.startsWith('D')).lastIndexOf(true);
      return all.slice(0, lastD + 1);
    };

    it('keeps VS Code command detection intact (E → C → buttons → D with exit code)', async () => {
      const run = await runBash(HOOK, 'echo two | cat\nfalse', {
        initFile: VSCODE_SCRIPT,
        env: { VSCODE_INJECTION: '1' },
      });
      expect(blocks()).toEqual([
        ['echo two | cat', 0],
        ['false', 1],
      ]);
      expect(markers(run.output)).toEqual(['E:echo two | cat', 'C', 'BUTTONS', 'D:0', 'E:false', 'C', 'BUTTONS', 'D:1']);
    });

    it('keeps VS Code working when the hook is sourced mid-session', async () => {
      const hookPath = path.join(REPO_ROOT, 'hooks', 'bash.sh').replace(/\\/g, '/');
      const run = await runBash('# no hook yet', `source '${hookPath}'\necho three\nfalse`, {
        initFile: VSCODE_SCRIPT,
        env: { VSCODE_INJECTION: '1' },
      });
      expect(blocks()).toEqual([
        ['echo three', 0],
        ['false', 1],
      ]);
      expect(markers(run.output)).toEqual([
        `E:source '${hookPath}'`,
        'C',
        'D:0',
        'E:echo three',
        'C',
        'BUTTONS',
        'D:0',
        'E:false',
        'C',
        'BUTTONS',
        'D:1',
      ]);
    });
  });
});
