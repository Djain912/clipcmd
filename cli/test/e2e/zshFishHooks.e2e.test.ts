/**
 * Same checks as the bash hook tests for zsh and fish. They run wherever
 * those shells are installed (CI on Linux/macOS) and are skipped otherwise;
 * set CLIPCMD_TEST_ZSH / CLIPCMD_TEST_FISH to point at a specific binary.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePortFile } from '../../src/config/portFile';
import { findShell, makeTempDir, removeDir, REPO_ROOT, runInTerminal, startTestDaemon, TestDaemon, tryLoadNodePty } from '../helpers';

const pty = tryLoadNodePty();
/** fish reads commands interactively (and fires its preexec events) only from a terminal. */
const FISH_PROMPT = "function fish_prompt; printf 'READY> '; end\n";

const SHELLS = [
  { name: 'zsh', bin: findShell('zsh'), hook: 'zsh.sh', args: ['-i'], rc: '.zshrc' },
  { name: 'fish', bin: findShell('fish'), hook: 'fish.fish', args: ['-i'], rc: path.join('.config', 'fish', 'config.fish') },
] as const;

for (const shell of SHELLS) {
  describe.skipIf(!shell.bin || (shell.name === 'fish' && !pty))(`${shell.name} hook (end to end)`, () => {
    let dir: string;
    let home: string;
    let daemon: TestDaemon;

    beforeEach(async () => {
      dir = makeTempDir();
      home = makeTempDir();
      daemon = await startTestDaemon({ configDir: dir });
      writePortFile(daemon.port, process.pid, path.join(dir, 'port'));
      const rc = path.join(home, shell.rc);
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      const hook = fs.readFileSync(path.join(REPO_ROOT, 'hooks', shell.hook), 'utf8');
      fs.writeFileSync(rc, shell.name === 'fish' ? FISH_PROMPT + hook : hook);
      // Only our rc: system zsh files may prompt (e.g. compinit about insecure directories)
      if (shell.name === 'zsh') fs.writeFileSync(path.join(home, '.zshenv'), 'unsetopt GLOBAL_RCS\n');
    });
    afterEach(async () => {
      await daemon.stop();
      removeDir(dir);
      removeDir(home);
    });

    async function run(script: string, extra: Record<string, string> = {}): Promise<string> {
      const env = { ...process.env, HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLIPCMD_CONFIG_DIR: dir, ...extra } as Record<string, string>;
      if (shell.name === 'fish') {
        const input = [...script.split('\n').filter((line) => line !== ''), 'exit'];
        return (await runInTerminal(shell.bin as string, [...shell.args], { cwd: home, env, input, ready: 'READY>' })).output;
      }
      return new Promise((resolve, reject) => {
        const child = spawn(shell.bin as string, [...shell.args], { cwd: home, env });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', () => resolve(out));
        child.stdin.end(`${script}\nexit\n`);
      });
    }

    it('records commands with exit codes and prints buttons', async () => {
      const out = await run(["echo 'a|b' | cat", 'false', "echo '100% & é'"].join('\n'));
      // (fish also records the harness's final `exit`, a real command there)
      expect(daemon.ringBuffer.getAll().filter((b) => b.command !== 'exit').map((b) => [b.command, b.exitCode])).toEqual([
        ["echo 'a|b' | cat", 0],
        ['false', 1],
        ["echo '100% & é'", 0],
      ]);
      expect(out.split('[COPY CMD]').length - 1).toBe(shell.name === 'fish' ? 4 : 3); // fish: + the `exit`
    });

    it('tells the daemon which terminal it runs in (Windows Terminal needs other links)', async () => {
      await run('echo one', { WT_SESSION: 'wt-1' });
      await run('echo two', { WT_SESSION: 'wt-1', TERM_PROGRAM: 'vscode' });
      await run('echo three');
      const recorded = daemon.ringBuffer.getAll().filter((b) => b.command !== 'exit');
      expect(recorded.map((b) => [b.command, b.term])).toEqual([
        ['echo one', 'wt'],
        ['echo two', 'vscode'],
        ['echo three', undefined],
      ]);
    });

    it('stays silent without a daemon', async () => {
      fs.rmSync(path.join(dir, 'port'));
      const out = await run('echo hi');
      expect(out).not.toContain('[COPY CMD]');
      expect(out).not.toMatch(/curl|error/i);
    });

    it('uses CLIPCMD_SESSION for output capture', async () => {
      const file = path.join(dir, 'sessions', 'sess.log');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, '');
      await run(`printf 'out\\n' >> '${file}'`, { CLIPCMD_SESSION: 'sess' });
      expect(daemon.ringBuffer.getAll()[0].output).toBe('out\n');
    });
  });
}
