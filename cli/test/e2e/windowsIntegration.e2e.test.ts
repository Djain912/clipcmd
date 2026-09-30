/**
 * Windows end to end: the clipcmd:// click handler (registered for real under
 * HKCU with a throwaway scheme name, launched through ShellExecute), the
 * .lnk shortcuts that Windows Terminal buttons use instead,
 * `clipcmd init` / `uninstall` against a temporary Windows Terminal settings
 * file, PowerShell's automatic `clipcmd shell`, and the whole flow of
 * capturing a command's output and clicking [COPY BOTH].
 */
import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writePortFile } from '../../src/config/portFile';
import {
  getHandlerScriptPath,
  getRegisteredCommand,
  handlerScript,
  registerProtocolHandler,
  unregisterProtocolHandler,
} from '../../src/installer/protocolHandler';
import { parseJsonc } from '../../src/installer/windowsTerminal';
import {
  fileUrl,
  getButtonShortcutDir,
  getShortcutArguments,
  getShortcutTemplatePath,
  lazyButtonShortcuts,
} from '../../src/shared/windowsShortcuts';
import {
  BIN,
  makeTempDir,
  PS_TEST_PRELUDE,
  removeDir,
  REPO_ROOT,
  startTestDaemon,
  stripAnsi,
  TestDaemon,
  tryLoadNodePty,
  waitFor,
} from '../helpers';

const onWindows = process.platform === 'win32';
const pty = tryLoadNodePty();
const SCHEME = `clipcmd-test-${randomBytes(4).toString('hex')}`;

/**
 * Opens a URL through ShellExecute, as unpackaged terminals (VS Code, ...) do.
 * Not the same as Windows Terminal: a Store (packaged) app does not see the
 * user's HKCU registrations, so a clipcmd:// link clicked there ends in "Get
 * an app to open this link". That is why Windows Terminal buttons are .lnk
 * shortcuts; see the shortcut test below and src/shared/windowsShortcuts.ts.
 */
function openUrl(url: string): void {
  spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], {
    windowsHide: true,
    timeout: 30000,
  });
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    );
  });
}

describe.skipIf(!onWindows)('Windows integration (end to end)', () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeAll(() => {
    process.env.CLIPCMD_URL_SCHEME = SCHEME;
  });
  afterAll(() => {
    unregisterProtocolHandler(SCHEME);
    process.env = savedEnv;
  });

  beforeEach(() => {
    dir = makeTempDir('clipcmd-win-');
    process.env.CLIPCMD_CONFIG_DIR = path.join(dir, 'clipcmd');
    fs.mkdirSync(process.env.CLIPCMD_CONFIG_DIR, { recursive: true });
  });
  afterEach(() => {
    unregisterProtocolHandler(SCHEME);
    removeDir(dir);
  });

  describe('the clipcmd:// handler script', () => {
    let server: http.Server;
    let hits: string[];

    beforeEach(async () => {
      hits = [];
      server = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url} host=${req.headers.host} origin=${req.headers.origin ?? '-'}`);
        res.end('OK');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      writePortFile((server.address() as net.AddressInfo).port, process.pid);
      fs.mkdirSync(path.dirname(getHandlerScriptPath()), { recursive: true });
      fs.writeFileSync(getHandlerScriptPath(), handlerScript(path.join(process.env.CLIPCMD_CONFIG_DIR!, 'port')));
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    // Async: a blocking spawn would stop this process's test server from answering
    const runHandler = (url: string) =>
      new Promise<{ status: number; output: string }>((resolve) => {
        execFile('cscript.exe', ['//NoLogo', '//E:JScript', getHandlerScriptPath(), url], { timeout: 30000 }, (err, stdout, stderr) =>
          resolve({ status: err ? 1 : 0, output: stdout + stderr })
        );
      });

    it('forwards copy/select actions to the daemon, including the form Windows normalizes to', async () => {
      for (const url of [
        'clipcmd://copy?id=a1&type=cmd',
        'clipcmd://copy/?id=a2&type=both',
        'clipcmd:select?id=a3',
        'clipcmd://copy-selected',
      ]) {
        expect((await runHandler(url)).status).toBe(0);
      }
      const port = (server.address() as net.AddressInfo).port;
      expect(hits).toEqual([
        `GET /copy?id=a1&type=cmd host=127.0.0.1:${port} origin=-`,
        `GET /copy?id=a2&type=both host=127.0.0.1:${port} origin=-`,
        `GET /select?id=a3 host=127.0.0.1:${port} origin=-`,
        `GET /copy-selected host=127.0.0.1:${port} origin=-`,
      ]);
    });

    it('ignores anything that is not a button action, and never errors', async () => {
      for (const url of ['clipcmd://shutdown', 'clipcmd://copy?id=a&type=cmd"&calc', 'clipcmd://copy?x=<script>', 'nonsense', '']) {
        const r = await runHandler(url);
        expect(r.status).toBe(0);
        expect(r.output).toBe('');
      }
      expect(hits).toEqual([]);
      fs.rmSync(path.join(process.env.CLIPCMD_CONFIG_DIR!, 'port'));
      expect((await runHandler('clipcmd://copy?id=a&type=cmd')).status).toBe(0); // no daemon: silent
    });
  });

  it('registers for the current user and a click copies through the daemon (no browser)', async () => {
    const d = await startTestDaemon({ configDir: process.env.CLIPCMD_CONFIG_DIR!, writePortFile: true });
    try {
      expect(registerProtocolHandler(SCHEME)).toBeUndefined();
      const command = getRegisteredCommand(SCHEME)!;
      expect(command).toMatch(/wscript\.exe" \/\/B \/\/NoLogo ".*open\.js" "%1"$/i);

      await new Promise((r) => http.get(`http://127.0.0.1:${d.port}/start?cmd=git%20status&pwd=%2F&sid=s&seq=1`, r));
      await new Promise<void>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: d.port, path: '/output?sid=s&seq=1', method: 'POST' }, () => resolve());
        req.end('On branch main');
      });
      await new Promise((r) => http.get(`http://127.0.0.1:${d.port}/end?exitCode=0&sid=s`, r));
      const id = d.ringBuffer.getAll()[0].id;

      openUrl(`${SCHEME}://copy?id=${id}&type=both`);
      await waitFor(() => d.clipboard.last === '$ git status\nOn branch main', 15000);
      openUrl(`${SCHEME}://copy?id=${id}&type=cmd`);
      await waitFor(() => d.clipboard.last === 'git status', 15000);
      openUrl(`${SCHEME}://select?id=${id}`);
      await waitFor(() => d.clipboard.last === '$ git status\nOn branch main\n\n', 15000);
    } finally {
      await d.stop();
    }
    unregisterProtocolHandler(SCHEME);
    expect(getRegisteredCommand(SCHEME)).toBeUndefined();
  }, 90000);

  it('Windows Terminal buttons are shortcuts that copy through the daemon when opened', async () => {
    expect(registerProtocolHandler(SCHEME)).toBeUndefined(); // also writes the shortcut template
    expect(fs.existsSync(getShortcutTemplatePath())).toBe(true);
    const d = await startTestDaemon({
      configDir: process.env.CLIPCMD_CONFIG_DIR!,
      writePortFile: true,
      linkScheme: () => 'clipcmd',
      buttonLinks: lazyButtonShortcuts(getHandlerScriptPath(), () => undefined),
    });
    try {
      // A `clipcmd shell` session, so all four buttons show
      fs.mkdirSync(d.sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(d.sessionsDir, 'wt.log'), '');
      await new Promise((r) => http.get(`http://127.0.0.1:${d.port}/start?cmd=git%20log&pwd=%2F&sid=wt&seq=1&term=wt`, r));
      await new Promise<void>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: d.port, path: '/output?sid=wt&seq=1', method: 'POST' }, () => resolve());
        req.end('commit 1a2b3c');
      });
      const body = await new Promise<string>((resolve) =>
        http.get(`http://127.0.0.1:${d.port}/end?exitCode=0&sid=wt`, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(b));
        })
      );
      const id = d.ringBuffer.getAll()[0].id;
      const links = [...body.matchAll(/\x1b\]8;;([^\x07]+)\x07/g)].map((m) => m[1]).filter((l) => l !== '');
      expect(links).toEqual(['cmd', 'output', 'both', 'select'].map((b) => fileUrl(path.join(getButtonShortcutDir(), `${id}-${b}.lnk`))));

      // What a Ctrl+click in Windows Terminal does with a file:// link
      openUrl(links[2]);
      await waitFor(() => d.clipboard.last === '$ git log\ncommit 1a2b3c', 15000);
      openUrl(links[0]);
      await waitFor(() => d.clipboard.last === 'git log', 15000);
    } finally {
      await d.stop();
    }
    unregisterProtocolHandler(SCHEME);
    expect(fs.existsSync(getShortcutTemplatePath())).toBe(false);
    expect(fs.existsSync(getButtonShortcutDir())).toBe(false);
  }, 90000);

  it('`clipcmd init` sets up silent links (+ Windows Terminal) and `uninstall` undoes it', async () => {
    const home = path.join(dir, 'home');
    const localAppData = path.join(dir, 'LocalAppData');
    const wtSettings = path.join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json');
    fs.mkdirSync(path.dirname(wtSettings), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const original = '{\n    // my settings\n    "defaultProfile": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}"\n}\n';
    fs.writeFileSync(wtSettings, original);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: localAppData,
      CLIPCMD_POWERSHELL_PROFILE: path.join(home, 'profile.ps1'),
    };

    const init = await cli(['init', 'powershell'], env);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain(`Copy buttons now copy silently (${SCHEME}:// links`);
    expect(init.stdout).toContain(`Windows Terminal: allowed ${SCHEME}:// links without confirmation`);
    expect(getRegisteredCommand(SCHEME)).toContain(getHandlerScriptPath());
    expect((parseJsonc(fs.readFileSync(wtSettings, 'utf8')) as { safeUriSchemes: string[] }).safeUriSchemes).toEqual([SCHEME]);
    expect(fs.existsSync(getShortcutTemplatePath())).toBe(true);

    let doctor = await cli(['doctor'], env);
    expect(doctor.stdout).toContain('[ OK ] Buttons copy through shortcut links (Windows Terminal needs them)');
    fs.rmSync(getShortcutTemplatePath());
    doctor = await cli(['doctor'], env);
    expect(doctor.stdout).toContain('[FAIL] Buttons cannot copy in Windows Terminal (the shortcut template is missing)');
    expect((await cli(['init', 'powershell'], env)).code).toBe(0);
    expect(fs.existsSync(getShortcutTemplatePath())).toBe(true);

    // The daemon now emits buttons that run the clipcmd:// handler (links: "auto"). Without a
    // terminal marker (Windows Terminal adopting a Start menu window) they are shortcuts
    const start = await cli(['start'], env);
    expect(start.code).toBe(0);
    const port = Number(fs.readFileSync(path.join(process.env.CLIPCMD_CONFIG_DIR!, 'port'), 'utf8').split(':')[0]);
    await new Promise((r) => http.get(`http://127.0.0.1:${port}/start?cmd=ls&pwd=%2F`, r));
    const buttons = await new Promise<string>((resolve) =>
      http.get(`http://127.0.0.1:${port}/end?exitCode=0`, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      })
    );
    const shortcut = /\x1b\]8;;(file:[^\x07]+-cmd\.lnk)\x07/.exec(buttons)?.[1];
    const args = shortcut ? getShortcutArguments(fs.readFileSync(fileURLToPath(shortcut))) : undefined;
    await cli(['stop'], env);
    expect(args).toContain(`${SCHEME}://copy?id=`);

    const uninstall = await cli(['uninstall', 'powershell'], env);
    expect(uninstall.code).toBe(0);
    expect(uninstall.stdout).toContain(`Removed the ${SCHEME}:// link handler`);
    expect(fs.existsSync(getShortcutTemplatePath())).toBe(false);
    expect(getRegisteredCommand(SCHEME)).toBeUndefined();
    expect(fs.readFileSync(wtSettings, 'utf8')).toBe(original);
  }, 120000);

  describe.skipIf(!pty)('PowerShell starting inside clipcmd shell automatically', () => {
    const HOOK = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'powershell.ps1'), 'latin1');

    function startPs(profile: string, env: Record<string, string>) {
      const profileFile = path.join(dir, 'profile.ps1');
      fs.writeFileSync(profileFile, PS_TEST_PRELUDE + profile, 'latin1');
      const term = pty!.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${profileFile}'`], {
        cols: 150,
        rows: 40,
        cwd: dir,
        env: { ...process.env, ...env } as Record<string, string>,
      });
      let screen = '';
      let exitCode: number | undefined;
      term.onData((d) => (screen += d));
      term.onExit((e) => (exitCode = e.exitCode));
      return { term, screen: () => stripAnsi(screen), exitCode: () => exitCode };
    }

    /** A fake `clipcmd` first on PATH: records its arguments, exits with FAKE_EXIT. */
    function fakeClipcmd(exit: number): Record<string, string> {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'clipcmd.cmd'), `@echo %*> "%~dp0args.txt"\r\n@exit /b ${exit}\r\n`);
      return { PATH: `${bin};${process.env.PATH}`, CLIPCMD_AUTOSHELL: '1' };
    }

    it('runs `clipcmd shell powershell` and exits with its exit code', async () => {
      const ps = startPs(HOOK, fakeClipcmd(7));
      await waitFor(() => ps.exitCode() !== undefined, 30000);
      expect(ps.exitCode()).toBe(7);
      expect(fs.readFileSync(path.join(dir, 'bin', 'args.txt'), 'utf8').trim()).toBe('shell powershell');
    }, 60000);

    it('carries on in the same session when clipcmd shell cannot start (exit 126)', async () => {
      const ps = startPs(`function global:prompt { 'READY> ' }\n${HOOK}`, fakeClipcmd(126));
      await waitFor(() => ps.screen().includes('READY>'), 30000);
      ps.term.write('"hooked=$([bool]$__ClipcmdState)"\r');
      await waitFor(() => ps.screen().includes('hooked=True'), 15000);
      expect(ps.exitCode()).toBeUndefined();
      ps.term.write('exit\r');
      await waitFor(() => ps.exitCode() !== undefined, 15000);
    }, 60000);

    it('only wraps plain interactive starts, and never in VS Code or when turned off', async () => {
      const ps = startPs(`function global:prompt { 'READY> ' }\n${HOOK}`, { CLIPCMD_AUTOSHELL: '0' });
      await waitFor(() => ps.screen().includes('READY>'), 30000);
      const cases = [
        ["'powershell.exe'", true],
        ["'powershell.exe','-NoLogo'", true],
        ["'pwsh.exe','-NoLogo','-ExecutionPolicy','Bypass','-WorkingDirectory','C:\\'", true],
        ["'powershell.exe','-NoExit','-Command','Enter-VsDevShell'", false],
        ["'powershell.exe','-File','x.ps1'", false],
        ["'powershell.exe','-EncodedCommand','ZQBjAGgAbwA='", false],
        ["'powershell.exe','Get-Date'", false],
      ] as const;
      const probe = cases.map(([args]) => `$(__Clipcmd-IsPlainInteractive @(${args}))`).join(',');
      ps.term.write(`"plain=${probe}"\r`);
      await waitFor(() => /plain=(True|False)(,(True|False))*/.test(ps.screen()), 15000);
      const got = /plain=((?:True|False)(?:,(?:True|False))*)/.exec(ps.screen())![1].split(',');
      expect(got).toEqual(cases.map(([, expected]) => (expected ? 'True' : 'False')));
      ps.term.write('exit\r');
      await waitFor(() => ps.exitCode() !== undefined, 15000);

      // TERM_PROGRAM=vscode never wraps even when forced
      const vs = startPs(`function global:prompt { 'READY> ' }\n${HOOK}`, { ...fakeClipcmd(7), TERM_PROGRAM: 'vscode' });
      await waitFor(() => vs.screen().includes('READY>'), 30000);
      expect(vs.exitCode()).toBeUndefined();
      vs.term.write('exit\r');
      await waitFor(() => vs.exitCode() !== undefined, 15000);
    }, 90000);
  });

  it.skipIf(!pty)('full flow: clipcmd shell + PowerShell captures output, and clicking [COPY BOTH] copies it', async () => {
    const configDir = process.env.CLIPCMD_CONFIG_DIR!;
    const d = await startTestDaemon({ configDir, writePortFile: true, linkScheme: () => 'clipcmd' });
    try {
      expect(registerProtocolHandler(SCHEME)).toBeUndefined();
      const profile = path.join(dir, 'profile.ps1');
      fs.writeFileSync(
        profile,
        `${PS_TEST_PRELUDE}function global:prompt { 'READY> ' }\n${fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'powershell.ps1'), 'latin1')}`,
        'latin1'
      );
      // clipcmd shell runs SHELL; this starts PowerShell with the test profile instead of the user's
      const wrapper = path.join(dir, 'ps.cmd');
      fs.writeFileSync(wrapper, `@powershell.exe -NoLogo -NoProfile -NoExit -Command ". '${profile}'"\r\n`);

      const term = pty!.spawn(process.execPath, [BIN, 'shell'], {
        cols: 120,
        rows: 20,
        cwd: dir,
        env: { ...process.env, CLIPCMD_CONFIG_DIR: configDir, SHELL: wrapper.replace(/\\/g, '/') } as Record<string, string>,
      });
      let screen = '';
      term.onData((data) => (screen += data));
      let exited = false;
      term.onExit(() => (exited = true));
      try {
        await waitFor(() => stripAnsi(screen).includes('READY>'), 30000);
        term.write("Write-Output 'captured text'; 1..3 | % { \"row $_\" }\r");
        await waitFor(() => d.ringBuffer.size === 1 && d.ringBuffer.getAll()[0].outputFromClient === true, 20000);
        const block = d.ringBuffer.getAll()[0];
        expect(block.output).toBe('captured text\nrow 1\nrow 2\nrow 3');

        // Click the [COPY BOTH] button that was printed in the terminal
        await waitFor(() => screen.includes('type=both'), 10000);
        const url = new RegExp(`${SCHEME}://copy\\?id=[0-9a-f-]+&type=both`).exec(screen)![0];
        openUrl(url);
        await waitFor(() => d.clipboard.last === `$ ${block.command}\n${block.output}`, 15000);

        term.write('exit\r');
        await waitFor(() => exited, 20000);
      } finally {
        if (!exited) term.kill();
      }
    } finally {
      await d.stop();
    }
  }, 120000);
});
