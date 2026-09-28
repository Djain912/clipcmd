/**
 * Full stack: a real terminal (outer node-pty) runs `clipcmd shell`, which
 * wraps bash in its own PTY; bash loads the hook from ~/.bashrc. Verifies the
 * daemon receives the command AND its captured output, and that the wrapper
 * exits (node-pty keeps handles open, which used to hang the CLI).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePortFile } from '../../src/config/portFile';
import {
  BIN,
  findBash,
  makeTempDir,
  removeDir,
  REPO_ROOT,
  startTestDaemon,
  stripAnsi,
  TestDaemon,
  tryLoadNodePty,
  waitFor,
} from '../helpers';

const BASH = findBash();
const pty = tryLoadNodePty();

describe.skipIf(!BASH || !pty)('clipcmd shell (real PTY, end to end)', () => {
  let dir: string;
  let home: string;
  let daemon: TestDaemon;

  beforeEach(async () => {
    dir = makeTempDir('clipcmd-pty-cfg-');
    home = makeTempDir('clipcmd-pty-home-');
    daemon = await startTestDaemon({ configDir: dir });
    writePortFile(daemon.port, process.pid, path.join(dir, 'port'));
    const hook = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'bash.sh'), 'utf8');
    fs.writeFileSync(path.join(home, '.bashrc'), `PS1='READY> '\n${hook}`);
    // Git Bash's bash.exe starts a login shell, which reads ~/.bash_profile (as on macOS)
    fs.writeFileSync(path.join(home, '.bash_profile'), 'source ~/.bashrc\n');
  });
  afterEach(async () => {
    await daemon.stop();
    removeDir(dir);
    removeDir(home);
  });

  it('captures command output for [COPY OUTPUT] and exits with the shell', async () => {
    const shellPath = (BASH as string).replace(/\\/g, '/');
    const term = pty!.spawn(process.execPath.replace(/\\/g, '/'), [BIN, 'shell'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: home,
      env: {
        ...process.env,
        SHELL: shellPath,
        HOME: home,
        USERPROFILE: home,
        CLIPCMD_CONFIG_DIR: dir,
        HISTFILE: path.join(home, '.bash_history'),
        PS1: 'READY> ',
        PROMPT_COMMAND: '',
      } as Record<string, string>,
    });

    let screen = '';
    term.onData((data) => (screen += data));
    let exitCode: number | undefined;
    term.onExit((e) => (exitCode = e.exitCode));

    try {
      await waitFor(() => stripAnsi(screen).includes('READY>'), 20000);

      term.write('echo "pty-$((6*7))"; printf "second line\\n"\r');
      await waitFor(() => daemon.ringBuffer.size === 1, 15000);
      await waitFor(() => stripAnsi(screen).includes('[COPY CMD]'), 5000);
      // The wrapper sends the rendered output once the button line is drawn
      await waitFor(() => daemon.ringBuffer.getAll()[0].outputFromClient === true, 5000);

      const block = daemon.ringBuffer.getAll()[0];
      expect(block.command).toBe('echo "pty-$((6*7))"; printf "second line\\n"');
      expect(block.exitCode).toBe(0);
      // Exactly what was displayed: no prompt, no buttons, no escape sequences
      expect(block.output).toBe('pty-42\nsecond line');
      // All four buttons: this session's output is captured
      for (const label of ['[COPY CMD]', '[COPY OUTPUT]', '[COPY BOTH]', '[+]']) {
        expect(stripAnsi(screen)).toContain(label);
      }

      // The session's capture file exists while the shell runs...
      const sessionFiles = fs.readdirSync(path.join(dir, 'sessions'));
      expect(sessionFiles).toHaveLength(1);

      term.write('exit 5\r');
      await waitFor(() => exitCode !== undefined, 15000);
      // ...and is removed when it ends; the wrapper passes the exit code through
      expect(exitCode).toBe(5);
      expect(fs.readdirSync(path.join(dir, 'sessions'))).toEqual([]);
    } finally {
      if (exitCode === undefined) term.kill();
    }
  }, 60000);
});
