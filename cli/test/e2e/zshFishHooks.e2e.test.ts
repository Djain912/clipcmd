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
import { findShell, makeTempDir, removeDir, REPO_ROOT, startTestDaemon, TestDaemon } from '../helpers';

const SHELLS = [
  { name: 'zsh', bin: findShell('zsh'), hook: 'zsh.sh', args: ['-i'], rc: '.zshrc' },
  { name: 'fish', bin: findShell('fish'), hook: 'fish.fish', args: ['-i'], rc: path.join('.config', 'fish', 'config.fish') },
] as const;

for (const shell of SHELLS) {
  describe.skipIf(!shell.bin)(`${shell.name} hook (end to end)`, () => {
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
      fs.writeFileSync(rc, fs.readFileSync(path.join(REPO_ROOT, 'hooks', shell.hook), 'utf8'));
    });
    afterEach(async () => {
      await daemon.stop();
      removeDir(dir);
      removeDir(home);
    });

    function run(script: string, env: Record<string, string> = {}): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = spawn(shell.bin as string, [...shell.args], {
          cwd: home,
          env: { ...process.env, HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLIPCMD_CONFIG_DIR: dir, ...env },
        });
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
      expect(daemon.ringBuffer.getAll().map((b) => [b.command, b.exitCode])).toEqual([
        ["echo 'a|b' | cat", 0],
        ['false', 1],
        ["echo '100% & é'", 0],
      ]);
      expect(out.split('[COPY CMD]').length - 1).toBe(3);
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
