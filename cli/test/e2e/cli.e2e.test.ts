/**
 * End-to-end tests of the built CLI (bin/clipcmd.js → dist/). Every test uses
 * its own CLIPCMD_CONFIG_DIR and HOME so the real ~/.config/clipcmd and shell
 * rc files are never touched, and a random port so a real daemon is unaffected.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BIN, freePort, makeTempDir, occupyPort, removeDir, REPO_ROOT, request, startTestDaemon, waitFor } from '../helpers';
import { HOOK_START_MARKER } from '../../src/installer/installer';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let configDir: string;
let home: string;
let port: number;

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    CLIPCMD_CONFIG_DIR: configDir,
    HOME: home,
    USERPROFILE: home,
    // Linux link handler and fish config live under these; keep them in `home`
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: undefined,
    CLIPCMD_POWERSHELL_PROFILE: path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ...extra,
  };
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
  return e;
}

function cli(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: env(extraEnv), timeout: 20000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function portFile(): { port: number; pid: number } | undefined {
  try {
    const [p, pid] = fs.readFileSync(path.join(configDir, 'port'), 'utf8').split(':').map(Number);
    return { port: p, pid };
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Where `clipcmd init` puts this platform's link handler (inside the test's dirs). */
function handlerPath(): string {
  if (process.platform === 'win32') return path.join(configDir, 'protocol', 'open.js');
  if (process.platform === 'darwin') return path.join(home, 'Applications', 'clipcmd-vitest link handler.app');
  return path.join(home, '.local', 'share', 'applications', 'clipcmd-vitest-url-handler.desktop');
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid as number;
}

beforeEach(async () => {
  configDir = makeTempDir('clipcmd-e2e-cfg-');
  home = makeTempDir('clipcmd-e2e-home-');
  port = await freePort();
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port }));
});

afterEach(async () => {
  // Never leave a daemon behind, even when a test fails midway
  const info = portFile();
  // Some tests register this very process as the "daemon"; never kill ourselves
  if (info?.pid && info.pid !== process.pid && alive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {
      // gone
    }
  }
  removeDir(configDir);
  removeDir(home);
});

describe('daemon lifecycle via the CLI', () => {
  it('start → status → start again → stop → stop again', async () => {
    let r = await cli(['status']);
    expect(r).toMatchObject({ code: 0, stdout: expect.stringContaining('Daemon is not running') });

    r = await cli(['start']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`Daemon started on port ${port} \\(PID \\d+\\)`));
    const info = portFile()!;
    expect(info.port).toBe(port);
    expect(alive(info.pid)).toBe(true);

    r = await cli(['start']);
    expect(r).toMatchObject({ code: 0, stdout: `Daemon is already running on port ${port} (PID ${info.pid})\n` });

    r = await cli(['status']);
    expect(r).toMatchObject({ code: 0, stdout: `Daemon is running on port ${port} (PID ${info.pid})\n` });

    r = await cli(['stop']);
    expect(r).toMatchObject({ code: 0, stdout: 'Daemon stopped. It stays off until you run `clipcmd start`.\n' });
    expect(portFile()).toBeUndefined();
    await waitFor(() => !alive(info.pid));

    r = await cli(['stop']);
    expect(r).toMatchObject({ code: 0, stdout: 'Daemon is not running\n' });

    const log = fs.readFileSync(path.join(configDir, 'daemon.log'), 'utf8');
    expect(log).toContain(`Daemon started successfully on port ${port}, PID ${info.pid}`);
    expect(log).toContain('Daemon stopped');
  });

  it('only listens on the loopback interface', async () => {
    expect((await cli(['start'])).code).toBe(0);
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return; // no LAN address to probe from
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: external.address, port, timeout: 1500 });
      socket.on('connect', () => (socket.destroy(), resolve(true)));
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => (socket.destroy(), resolve(false)));
    });
    expect(reachable).toBe(false);
  });

  it('recovers from a stale port file left by a crashed daemon', async () => {
    fs.writeFileSync(path.join(configDir, 'port'), `${port}:${deadPid()}`);
    expect((await cli(['status'])).stdout).toContain('stale port file');

    const r = await cli(['start']);
    expect(r.code).toBe(0);
    expect(alive(portFile()!.pid)).toBe(true);
  });

  it('stop cleans up a stale port file', async () => {
    fs.writeFileSync(path.join(configDir, 'port'), `${port}:${deadPid()}`);
    const r = await cli(['stop']);
    expect(r).toMatchObject({ code: 0, stdout: 'Daemon is not running (removed stale port file)\n' });
    expect(portFile()).toBeUndefined();
  });

  it('never kills a live process that is registered but not responding', async () => {
    // Our own pid is alive, and nothing listens on `port`
    fs.writeFileSync(path.join(configDir, 'port'), `${port}:${process.pid}`);
    expect((await cli(['status'])).stdout).toContain(`Daemon process ${process.pid} is alive but not responding`);
    const r = await cli(['stop']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not responding');
    expect(fs.existsSync(path.join(configDir, 'port'))).toBe(true);
  });

  it.each(['garbage', '', '99999:1', ':'])('treats an invalid port file (%j) as not running', async (content) => {
    fs.writeFileSync(path.join(configDir, 'port'), content);
    expect((await cli(['status'])).stdout).toContain('Daemon is not running');
    expect((await cli(['start'])).code).toBe(0);
    expect(portFile()!.port).toBe(port);
  });

  it('uses the next port when the configured one is busy', async () => {
    const blocker = await occupyPort(port);
    try {
      const r = await cli(['start']);
      expect(r.code).toBe(0);
      expect(portFile()!.port).toBeGreaterThan(port);
    } finally {
      blocker.close();
    }
  });

  it('starts with defaults for invalid config values and logs a warning', async () => {
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port, ringBufferSize: -5 }));
    expect((await cli(['start'])).code).toBe(0);
    const log = fs.readFileSync(path.join(configDir, 'daemon.log'), 'utf8');
    expect(log).toContain('Ignoring invalid config value ringBufferSize=-5');
    expect(log).toContain('ringBufferSize=200');
  });

  it('two simultaneous starts leave exactly one daemon running', async () => {
    const [a, b] = await Promise.all([cli(['start']), cli(['start'])]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const info = portFile()!;
    await new Promise((r) => setTimeout(r, 500));
    const nodePids = [a, b]
      .map((r) => /PID (\d+)/.exec(r.stdout)?.[1])
      .filter((p): p is string => p !== undefined)
      .map(Number);
    for (const pid of new Set(nodePids)) {
      expect(alive(pid)).toBe(pid === info.pid);
    }
    expect((await cli(['status'])).stdout).toContain(`PID ${info.pid}`);
  });

  it('a daemon killed by a signal is reported stale and can be restarted', async () => {
    await cli(['start']);
    const { pid } = portFile()!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !alive(pid));
    expect((await cli(['status'])).stdout).toContain('Daemon is not running');
    expect((await cli(['start'])).code).toBe(0);
    expect(portFile()!.pid).not.toBe(pid);
  });

  it('reports a daemon that fails to start', async () => {
    // A file where the config directory should be makes every write fail
    removeDir(configDir);
    fs.writeFileSync(configDir, 'not a directory');
    const r = await cli(['start']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Daemon failed to start');
    fs.rmSync(configDir);
    fs.mkdirSync(configDir);
  });
});

describe('stop / start --auto (what the shell hooks run)', () => {
  const marker = () => path.join(configDir, 'stopped');

  it('start --auto starts a missing daemon silently', async () => {
    const r = await cli(['start', '--auto', '--quiet']);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(alive(portFile()!.pid)).toBe(true);
    // Already running: still silent
    expect(await cli(['start', '--auto', '--quiet'])).toMatchObject({ code: 0, stdout: '' });
  });

  it('after `clipcmd stop` the daemon stays off until an explicit start', async () => {
    expect((await cli(['start'])).code).toBe(0);
    const { pid } = portFile()!;
    expect((await cli(['stop'])).code).toBe(0);
    expect(fs.existsSync(marker())).toBe(true);
    await waitFor(() => !alive(pid));

    expect(await cli(['start', '--auto', '--quiet'])).toMatchObject({ code: 0, stdout: '' });
    expect(portFile()).toBeUndefined();

    const r = await cli(['start']);
    expect(r.stdout).toContain('Daemon started');
    expect(fs.existsSync(marker())).toBe(false);
    expect(alive(portFile()!.pid)).toBe(true);
  });

  it('`stop` with no daemon running still keeps automatic starts off', async () => {
    expect(await cli(['stop'])).toMatchObject({ code: 0, stdout: 'Daemon is not running\n' });
    expect(fs.existsSync(marker())).toBe(true);
    expect((await cli(['start', '--auto'])).code).toBe(0);
    expect(portFile()).toBeUndefined();
  });
});

describe('doctor', () => {
  it('fails without a shell hook and explains the fix', async () => {
    const r = await cli(['doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('[FAIL] No shell hook installed');
    expect(r.stdout).toContain('Run `clipcmd init`');
    expect(r.stdout).toContain('[WARN] Daemon not running');
    expect(r.stdout).toMatch(/\[ OK \] Node\.js \d+/);
  });

  it('passes once set up, and flags outdated hooks and a stopped daemon', async () => {
    expect((await cli(['init', 'bash'])).code).toBe(0);
    expect((await cli(['start'])).code).toBe(0);
    let r = await cli(['doctor']);
    expect(r.stdout).toContain('[ OK ] Shell hook installed for: bash');
    expect(r.stdout).toContain(`[ OK ] Daemon running on port ${port}`);
    expect(r.stdout).not.toContain('[FAIL]');
    expect(r.code).toBe(0);

    const bashrc = path.join(home, '.bashrc');
    fs.writeFileSync(bashrc, fs.readFileSync(bashrc, 'utf8').replace('_clipcmd_ready=0', '_clipcmd_ready=2'));
    expect((await cli(['stop'])).code).toBe(0);
    r = await cli(['doctor']);
    expect(r.stdout).toContain('[WARN] The bash hook is from another clipcmd version');
    expect(r.stdout).toContain('Run `clipcmd init bash`');
    expect(r.stdout).toContain('[WARN] Daemon stopped with `clipcmd stop`');
  });

  it('reports invalid config values', async () => {
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ port, links: 'carrier-pigeon' }));
    const r = await cli(['doctor']);
    expect(r.stdout).toMatch(/\[WARN\] Config problems: .*links/);
  });
});

describe('open (the Linux / macOS link handler)', () => {
  const savedConfigDir = process.env.CLIPCMD_CONFIG_DIR;
  afterEach(() => {
    process.env.CLIPCMD_CONFIG_DIR = savedConfigDir;
  });

  async function daemonWithBlock() {
    process.env.CLIPCMD_CONFIG_DIR = configDir; // the test daemon writes its port file here
    const daemon = await startTestDaemon({ configDir, writePortFile: true });
    await request(daemon.port, '/start?cmd=echo%20hi&pwd=%2Ftmp&sid=s1');
    const { body } = await request(daemon.port, '/end?exitCode=0&sid=s1');
    const id = /[?&]id=([0-9a-f-]+)/.exec(body)![1];
    return { daemon, id };
  }

  it('forwards a button click to the daemon', async () => {
    const { daemon, id } = await daemonWithBlock();
    try {
      expect((await cli(['open', `clipcmd://copy?id=${id}&type=cmd`])).code).toBe(0);
      expect(daemon.clipboard.last).toBe('echo hi');
      // Windows-style normalized URL
      expect((await cli(['open', `clipcmd://select/?id=${id}`])).code).toBe(0);
      expect(daemon.clipboard.writes).toHaveLength(2);
      expect(daemon.clipboard.last).toContain('$ echo hi'); // [+] collects in transcript form
      // Unknown block
      expect((await cli(['open', 'clipcmd://copy?id=999999&type=cmd'])).code).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it.each(['', 'clipcmd://shutdown', 'clipcmd://copy?id=1&type=cmd#x', 'https://example.com/copy?id=1', 'clipcmd://copy?a=<b>'])(
    'rejects %j with exit code 2',
    async (url) => {
      const r = await cli(url ? ['open', url] : ['open']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Usage: clipcmd open');
    }
  );

  it('exits 1 when no daemon is running', async () => {
    expect((await cli(['open', 'clipcmd://copy?id=1&type=cmd'])).code).toBe(1);
  });
});

describe('uninstall --all', () => {
  it('removes every hook and the link handler, and stops the daemon', async () => {
    const bashrc = path.join(home, '.bashrc');
    const zshrc = path.join(home, '.zshrc');
    fs.writeFileSync(bashrc, 'export KEEP=1\n');
    expect((await cli(['init', 'bash'])).code).toBe(0);
    expect((await cli(['init', 'zsh'])).code).toBe(0);
    expect((await cli(['start'])).code).toBe(0);
    const { pid } = portFile()!;

    const r = await cli(['uninstall', '--all']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Removed the bash hook from ${bashrc}`);
    expect(r.stdout).toContain(`Removed the zsh hook from ${zshrc}`);
    expect(r.stdout).toContain('Stopped the daemon.');
    expect(fs.readFileSync(bashrc, 'utf8')).toBe('export KEEP=1\n');
    expect(fs.readFileSync(zshrc, 'utf8')).not.toContain(HOOK_START_MARKER);
    await waitFor(() => !alive(pid));
    expect(fs.existsSync(handlerPath())).toBe(false);

    // Nothing left: still succeeds
    expect((await cli(['uninstall', '--all'])).code).toBe(0);
  });

  it('removes the link handler with the last single-shell uninstall', async () => {
    expect((await cli(['init', 'bash'])).code).toBe(0);
    expect((await cli(['init', 'fish'])).code).toBe(0);
    const registered = fs.existsSync(handlerPath()); // e.g. Linux without xdg-mime cannot register
    await cli(['uninstall', 'bash']);
    expect(fs.existsSync(handlerPath())).toBe(registered);
    await cli(['uninstall', 'fish']);
    expect(fs.existsSync(handlerPath())).toBe(false);
  });
});

describe('init / uninstall via the CLI', () => {
  const bashrc = () => path.join(home, '.bashrc');

  it('installs, refreshes, and removes the hook for an explicit shell', async () => {
    fs.writeFileSync(bashrc(), 'export KEEP=1\n');

    let r = await cli(['init', 'bash']);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toContain(`clipcmd hook installed successfully for bash in ${bashrc()}`);
    expect(r.stdout).toContain('source ~/.bashrc');
    expect(fs.readFileSync(bashrc(), 'utf8')).toContain(HOOK_START_MARKER);

    r = await cli(['init', 'bash']);
    expect(r.stdout).toContain('already up to date');

    r = await cli(['uninstall', 'bash']);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(bashrc(), 'utf8')).toBe('export KEEP=1\n');

    r = await cli(['uninstall', 'bash']);
    expect(r.stdout).toContain('not installed');
  });

  it('warns when ~/.bash_profile does not load ~/.bashrc (login shells)', async () => {
    fs.writeFileSync(path.join(home, '.bash_profile'), 'export PATH=$PATH:~/bin\n');
    let r = await cli(['init', 'bash']);
    expect(r.stdout).toContain('does not load ~/.bashrc');

    fs.writeFileSync(path.join(home, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n');
    await cli(['uninstall', 'bash']);
    r = await cli(['init', 'bash']);
    expect(r.stdout).not.toContain('does not load');
  });

  it('detects the shell from SHELL', async () => {
    const r = await cli(['init'], { SHELL: '/usr/bin/zsh' });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toContain(HOOK_START_MARKER);
  });

  it('creates ~/.config/fish/ for fish', async () => {
    expect((await cli(['init', 'fish'])).code).toBe(0);
    expect(fs.existsSync(path.join(home, '.config', 'fish', 'config.fish'))).toBe(true);
  });

  it.each([
    [['init', 'cmd'], {}],
    [['init', 'tcsh'], {}],
    [['init'], { SHELL: '/bin/tcsh' }],
    [['uninstall', 'cmd'], {}],
  ])('%j with %j fails with the list of supported shells', async (args, extraEnv) => {
    const r = await cli(args, extraEnv);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Supported shells: zsh, bash, fish, powershell, pwsh');
  });

  // On Windows the shell is then detected from parent processes (covered in unit tests)
  it.skipIf(process.platform === 'win32')('fails clearly when no shell can be detected', async () => {
    const r = await cli(['init'], { SHELL: undefined });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Could not detect your shell');
  });

  it('refuses to edit a config with a broken hook block', async () => {
    const content = `a\n${HOOK_START_MARKER}\nmy settings\n`;
    fs.writeFileSync(bashrc(), content);
    for (const cmd of ['init', 'uninstall']) {
      const r = await cli([cmd, 'bash']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('without a matching');
    }
    expect(fs.readFileSync(bashrc(), 'utf8')).toBe(content);
  });
});

describe('init / uninstall for PowerShell', () => {
  const profile = () => path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  const hasWindowsPowerShell =
    process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '0'], { windowsHide: true }).status === 0;

  it('installs into the profile keeping its UTF-16 encoding, then uninstalls byte-for-byte', async () => {
    fs.mkdirSync(path.dirname(profile()), { recursive: true });
    // What `"Set-Alias g git" > $PROFILE` produces in Windows PowerShell 5.1
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Set-Alias g git\r\n', 'utf16le')]);
    fs.writeFileSync(profile(), original);

    const r = await cli(['init', 'powershell'], { CLIPCMD_POWERSHELL_PROFILE: profile() });
    if (r.code === 1 && r.stderr.includes('execution policy')) return; // machine policy blocks profiles
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`clipcmd hook installed successfully for powershell in ${profile()}`);
    expect(r.stdout).toContain('. $PROFILE');
    const installed = fs.readFileSync(profile());
    expect([installed[0], installed[1]]).toEqual([0xff, 0xfe]);
    expect(installed.subarray(2).toString('utf16le')).toContain(`Set-Alias g git\r\n${HOOK_START_MARKER}\n`);

    expect((await cli(['init', 'powershell'], { CLIPCMD_POWERSHELL_PROFILE: profile() })).stdout).toContain('already up to date');
    expect((await cli(['uninstall', 'powershell'], { CLIPCMD_POWERSHELL_PROFILE: profile() })).code).toBe(0);
    expect(fs.readFileSync(profile())).toEqual(original);
  });

  it.skipIf(!hasWindowsPowerShell)('detects PowerShell automatically when run from it (PowerShell sets no SHELL)', () => {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `& '${process.execPath}' '${BIN}' init`], {
      encoding: 'utf8',
      env: env({ SHELL: undefined, CLIPCMD_POWERSHELL_PROFILE: profile() }),
      windowsHide: true,
      timeout: 60000,
    });
    expect(r.stdout + r.stderr).toContain(`clipcmd hook installed successfully for powershell in ${profile()}`);
    expect(fs.readFileSync(profile(), 'utf8')).toContain(HOOK_START_MARKER);
  });
});

describe('misc CLI behaviour', () => {
  it('--version prints the package version', async () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(await cli(['--version'])).toMatchObject({ code: 0, stdout: `${version}\n` });
  });

  it('unknown commands exit 1', async () => {
    const r = await cli(['bogus']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown command: bogus');
  });

  it('shell refuses to run without a TTY (exit 126: "could not start")', async () => {
    const r = await cli(['shell']);
    expect(r.code).toBe(126);
    expect(r.stderr).toMatch(/interactive terminal|node-pty is not installed/);
  });

  it('the CLI process exits promptly (no lingering handles)', async () => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, 'status'], { env: env(), stdio: 'ignore' });
    await new Promise((resolve) => child.on('exit', resolve));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
