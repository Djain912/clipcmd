/**
 * Runs the real hooks/powershell.ps1 in an interactive PowerShell (a real
 * console via node-pty/ConPTY, so PSReadLine is active exactly as in a
 * terminal) against an in-process daemon, then inspects what the daemon
 * recorded. Runs for Windows PowerShell 5.1 and PowerShell 7 when available.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePortFile } from '../../src/config/portFile';
import {
  findVsCodeBashIntegration,
  freePort,
  makeTempDir,
  removeDir,
  REPO_ROOT,
  startTestDaemon,
  stripAnsi,
  TestDaemon,
  tryLoadNodePty,
  waitFor,
} from '../helpers';

const pty = tryLoadNodePty();
const HOOK = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'powershell.ps1'), 'latin1');
/** Custom prompt so tests can count prompts and see the $? it receives. */
const PROMPT = 'function global:prompt { "PS[$?]> " }\n';
const PROMPT_RE = /(?:PS|NEW)\[(?:True|False)\]>/g;
/** A native program exiting with `code` (PowerShell 7 also runs on Linux and macOS). */
const exitWith = (code: number) => (process.platform === 'win32' ? `cmd /c exit ${code}` : `sh -c 'exit ${code}'`);

function available(exe: string): boolean {
  const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  return r.status === 0;
}

const EDITIONS = [
  { name: 'Windows PowerShell 5.1', exe: 'powershell.exe', ok: process.platform === 'win32' && available('powershell.exe') },
  { name: 'PowerShell 7', exe: process.env.CLIPCMD_TEST_PWSH || 'pwsh', ok: available(process.env.CLIPCMD_TEST_PWSH || 'pwsh') },
];

const VSCODE_PS_SCRIPT = (() => {
  const bash = findVsCodeBashIntegration();
  const ps = bash && path.join(path.dirname(bash), 'shellIntegration.ps1');
  return ps && fs.existsSync(ps) ? ps : undefined;
})();

for (const edition of EDITIONS) {
  describe.skipIf(!pty || !edition.ok)(`PowerShell hook (end to end, ${edition.name})`, () => {
    let dir: string;
    let home: string;
    let daemon: TestDaemon;

    beforeEach(async () => {
      dir = makeTempDir('clipcmd-ps-cfg-');
      home = makeTempDir('clipcmd-ps-home-');
      daemon = await startTestDaemon({ configDir: dir });
      writePortFile(daemon.port, process.pid, path.join(dir, 'port'));
    });
    afterEach(async () => {
      await daemon.stop();
      removeDir(dir);
      removeDir(home);
    });

    /**
     * Starts PowerShell, dot-sources `profile` (as PowerShell does with
     * $PROFILE), types each command and waits for the next prompt.
     */
    async function runPs(
      profile: string,
      commands: string[],
      options: { env?: Record<string, string>; vscode?: boolean } = {}
    ): Promise<{ screen: string; ms: number[] }> {
      const profileFile = path.join(home, 'profile.ps1');
      fs.writeFileSync(profileFile, profile, 'latin1');
      let script = `. '${profileFile}'`;
      if (options.vscode) script += `; . '${VSCODE_PS_SCRIPT}'`;

      const term = pty!.spawn(edition.exe, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', script], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: home,
        env: { ...process.env, CLIPCMD_CONFIG_DIR: dir, ...options.env } as Record<string, string>,
      });
      let screen = '';
      term.onData((d) => (screen += d));
      let exited = false;
      term.onExit(() => (exited = true));
      const prompts = () => (stripAnsi(screen).match(PROMPT_RE) ?? []).length;

      const ms: number[] = [];
      try {
        await waitFor(() => prompts() >= 1, 30000);
        for (const command of commands) {
          const before = prompts();
          const started = Date.now();
          term.write(`${command}\r`);
          await waitFor(() => prompts() > before, 20000);
          ms.push(Date.now() - started);
        }
        term.write('exit\r');
        await waitFor(() => exited, 15000);
      } finally {
        if (!exited) term.kill();
      }
      return { screen, ms };
    }

    const blocks = () => daemon.ringBuffer.getAll().map((b) => [b.command, b.exitCode]);
    const buttonCount = (screen: string) => screen.split('[COPY CMD]').length - 1;

    it('records commands with exact text and exit codes, and prints buttons', async () => {
      const { screen } = await runPs(PROMPT + HOOK, [
        'Write-Output hello',
        'Get-ChildItem | Select-Object -First 1 | Out-Null',
        "Get-Item 'C:\\definitely\\missing'",
        exitWith(7),
        exitWith(7),
        exitWith(0),
        "Write-Output 'h\u00e9llo \u20ac 100% & a=b'",
      ]);
      expect(blocks()).toEqual([
        ['Write-Output hello', 0],
        ['Get-ChildItem | Select-Object -First 1 | Out-Null', 0],
        ["Get-Item 'C:\\definitely\\missing'", 1],
        [exitWith(7), 7],
        [exitWith(7), 7],
        [exitWith(0), 0],
        ["Write-Output 'h\u00e9llo \u20ac 100% & a=b'", 0],
      ]);
      expect(buttonCount(screen)).toBe(7);
      // macOS: the temp dir is reached through a symlink (/var -> /private/var)
      expect([home, fs.realpathSync.native(home)]).toContain(daemon.ringBuffer.getAll()[0].pwd);
    }, 120000);

    it('ignores empty lines and keeps $? and $LASTEXITCODE for the user', async () => {
      const { screen } = await runPs(PROMPT + HOOK, ['', "Get-Item 'C:\\nope'", '', exitWith(3), '"LEC=$LASTEXITCODE"']);
      expect(blocks()).toEqual([
        ["Get-Item 'C:\\nope'", 1],
        [exitWith(3), 3],
        ['"LEC=$LASTEXITCODE"', 0],
      ]);
      const text = stripAnsi(screen);
      expect(text).toContain('PS[False]>'); // the original prompt still sees the failure
      expect(text).toContain('LEC=3');
    }, 120000);

    it('produces no visible errors, even under Set-StrictMode -Version Latest', async () => {
      const { screen } = await runPs(`Set-StrictMode -Version Latest\n${PROMPT}${HOOK}`, ['Write-Output ok', '1/0']);
      expect(blocks()).toEqual([
        ['Write-Output ok', 0],
        ['1/0', 1],
      ]);
      // Only the user's own error (divide by zero) may appear, nothing from the hook
      const text = stripAnsi(screen);
      expect(text).toMatch(/divide by zero/i);
      expect(text).not.toMatch(/__Clipcmd|cannot be retrieved because it has not been set|PropertyNotFoundStrict|VariableIsUndefined/i);
    }, 120000);

    it('loading the profile twice does not double-register', async () => {
      await runPs(PROMPT + HOOK + '\n' + HOOK, ['Write-Output once']);
      expect(blocks()).toEqual([['Write-Output once', 0]]);
    }, 120000);

    it('works with the default prompt too', async () => {
      // PSReadLine's default prompt is "PS <path>> "; count those instead
      const profileFile = path.join(home, 'profile.ps1');
      fs.writeFileSync(profileFile, HOOK, 'latin1');
      const term = pty!.spawn(edition.exe, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${profileFile}'`], {
        cols: 200,
        rows: 50,
        cwd: home,
        env: { ...process.env, CLIPCMD_CONFIG_DIR: dir } as Record<string, string>,
      });
      let screen = '';
      term.onData((d) => (screen += d));
      let exited = false;
      term.onExit(() => (exited = true));
      try {
        await waitFor(() => /PS [^\r\n]*>/.test(stripAnsi(screen)), 30000);
        term.write('Write-Output default\r');
        await waitFor(() => daemon.ringBuffer.size === 1 && screen.includes('[COPY CMD]'), 20000);
        // Exit cleanly: a killed powershell.exe keeps the temp dir busy for a while
        term.write('exit\r');
        await waitFor(() => exited, 15000);
      } finally {
        if (!exited) term.kill();
      }
      expect(blocks()).toEqual([['Write-Output default', 0]]);
    }, 120000);

    it('re-wraps a prompt that replaced ours (oh-my-posh, starship, ...)', async () => {
      const { screen } = await runPs(PROMPT + HOOK, [
        "function global:prompt { 'NEW[' + $? + ']> ' }",
        'Write-Output after',
        'Write-Output again',
      ]);
      const recorded = blocks();
      expect(recorded.slice(-2)).toEqual([
        ['Write-Output after', 0],
        ['Write-Output again', 0],
      ]);
      expect(stripAnsi(screen)).toContain('NEW[True]>');
    }, 120000);

    it('stays silent without a daemon', async () => {
      fs.rmSync(path.join(dir, 'port'));
      const { screen } = await runPs(PROMPT + HOOK, ['Write-Output a', 'Write-Output b']);
      expect(buttonCount(screen)).toBe(0);
      expect(stripAnsi(screen)).not.toMatch(/exception|error/i);
      expect(daemon.ringBuffer.size).toBe(0);
    }, 120000);

    it('backs off after the daemon stops answering', async () => {
      writePortFile(await freePort(), process.pid, path.join(dir, 'port')); // nothing listens there
      const { screen, ms } = await runPs(PROMPT + HOOK, ['Write-Output 1', 'Write-Output 2', 'Write-Output 3', 'Write-Output 4']);
      expect(buttonCount(screen)).toBe(0);
      // Only the first command may wait for the 1s timeout; the rest skip the daemon
      const later = ms.slice(1);
      expect(Math.max(...later)).toBeLessThan(900);
    }, 120000);

    it('routes output capture through CLIPCMD_SESSION', async () => {
      const file = path.join(dir, 'sessions', 'ps-session.log');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, 'earlier\n');
      await runPs(PROMPT + HOOK, [`[IO.File]::AppendAllText('${file}', 'captured')`], {
        env: { CLIPCMD_SESSION: 'ps-session' },
      });
      expect(daemon.ringBuffer.getAll()[0].output).toBe('captured');
    }, 120000);

    it('does nothing in non-interactive PowerShell (scripts, -Command)', () => {
      const profileFile = path.join(home, 'profile.ps1');
      fs.writeFileSync(profileFile, HOOK, 'latin1');
      const r = spawnSync(edition.exe, ['-NoLogo', '-NoProfile', '-Command', `. '${profileFile}'; 'x'; exit 0`], {
        encoding: 'utf8',
        env: { ...process.env, CLIPCMD_CONFIG_DIR: dir },
        windowsHide: true,
        timeout: 30000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('x');
      expect(r.stderr).toBe('');
      expect(daemon.ringBuffer.size).toBe(0);
    }, 60000);

    describe.skipIf(!VSCODE_PS_SCRIPT)("with VS Code's real PowerShell shell integration", () => {
      it('keeps VS Code command detection intact (E → C → buttons → D with exit code)', async () => {
        const { screen } = await runPs(PROMPT + HOOK, ['Write-Output two', "Get-Item 'C:\\nope'"], { vscode: true });
        expect(blocks()).toEqual([
          ['Write-Output two', 0],
          ["Get-Item 'C:\\nope'", 1],
        ]);
        const markers = [...screen.matchAll(/\x1b\]633;([CDE])(?:;([^\x07]*))?\x07|\[COPY CMD\]/g)].map((m) =>
          m[0] === '[COPY CMD]' ? 'BUTTONS' : m[1] === 'E' ? `E:${m[2].replace(/;[^;]*$/, '')}` : m[2] !== undefined ? `${m[1]}:${m[2]}` : m[1]
        );
        const lastD = markers.map((m) => m.startsWith('D')).lastIndexOf(true);
        expect(markers.slice(0, lastD + 1).filter((m) => m !== 'D')).toEqual([
          'E:Write-Output two',
          'C',
          'BUTTONS',
          'D:0',
          "E:Get-Item 'C:\\x5cnope'",
          'C',
          'BUTTONS',
          'D:1',
        ]);
      }, 120000);
    });
  });
}
