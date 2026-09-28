import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DaemonStatus } from '../../daemonClient';
import type { StartResult } from '../../extension';

const EXTENSION_ID = 'djain912.clipcmd';
const COMMAND = 'clipcmd.checkDaemon';
const START_COMMAND = 'clipcmd.startDaemon';

interface Shown {
  level: 'info' | 'warning' | 'error';
  message: string;
  items: string[];
}

/** Records notifications instead of showing them (they would otherwise pile up). */
const shown: Shown[] = [];
/** Every notification of the whole run (`shown` is reset per test). */
const allShown: Shown[] = [];
/** The button the "user" clicks on the next notification that offers it. */
let choice: string | undefined;
const originals = {
  info: vscode.window.showInformationMessage,
  warning: vscode.window.showWarningMessage,
  error: vscode.window.showErrorMessage,
};

function stubNotifications(): void {
  const record =
    (level: Shown['level']) =>
    (message: string, ...items: unknown[]): Thenable<string | undefined> => {
      const labels = items.filter((i): i is string => typeof i === 'string');
      shown.push({ level, message, items: labels });
      allShown.push({ level, message, items: labels });
      const clicked = choice !== undefined && labels.includes(choice) ? choice : undefined;
      if (clicked) choice = undefined;
      return Promise.resolve(clicked);
    };
  const win = vscode.window as unknown as Record<string, unknown>;
  win.showInformationMessage = record('info');
  win.showWarningMessage = record('warning');
  win.showErrorMessage = record('error');
}

function portFile(): string {
  const dir = process.env.CLIPCMD_CONFIG_DIR;
  assert.ok(dir, 'the runner must set CLIPCMD_CONFIG_DIR');
  return path.join(dir, 'port');
}

async function check(): Promise<DaemonStatus> {
  return (await vscode.commands.executeCommand<DaemonStatus>(COMMAND)) as DaemonStatus;
}

async function waitUntil(condition: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A fake `clipcmd` executable: appends its arguments to args.txt next to it,
 * prints `stdout`, and exits with `exitCode`.
 */
function fakeCli(dir: string, stdout: string, exitCode = 0): string {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, 'clipcmd.cmd');
    const out = exitCode === 0 ? `@echo ${stdout}` : `@echo ${stdout} 1>&2`;
    fs.writeFileSync(file, `@echo %*>> "%~dp0args.txt"\r\n${out}\r\n@exit /b ${exitCode}\r\n`);
    return file;
  }
  const file = path.join(dir, 'clipcmd');
  const out = exitCode === 0 ? `echo '${stdout}'` : `echo '${stdout}' >&2`;
  fs.writeFileSync(file, `#!/bin/sh\necho "$*" >> "$(dirname "$0")/args.txt"\n${out}\nexit ${exitCode}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

async function setCliPath(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('clipcmd').update('cliPath', value, vscode.ConfigurationTarget.Global);
}

/** Shell and command for the real-terminal test on this platform. */
function terminalShell(): { shellPath: string; command: string } {
  if (process.platform === 'win32') {
    return {
      shellPath: 'powershell.exe',
      command: "Write-Host 'progress 5%' -NoNewline; Write-Host \"`rprogress 100%\"; 'second line'",
    };
  }
  return {
    shellPath: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    command: "printf 'progress 5%%\\rprogress 100%%\\nsecond line\\n'",
  };
}

suite('clipcmd extension (in VS Code)', () => {
  let server: http.Server | undefined;
  let scratch: string;

  suiteSetup(() => {
    stubNotifications();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcmd-vscode-cli-'));
  });

  suiteTeardown(async () => {
    Object.assign(vscode.window as unknown as Record<string, unknown>, {
      showInformationMessage: originals.info,
      showWarningMessage: originals.warning,
      showErrorMessage: originals.error,
    });
    await setCliPath(undefined);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  setup(() => {
    shown.length = 0;
    choice = undefined;
    fs.rmSync(portFile(), { force: true });
  });

  teardown(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function fakeDaemon(status = 200, body = '{"status":"ok"}'): Promise<number> {
    server = http.createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  test('activates after startup (not during it) and shows nothing on its own', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be loaded`);
    assert.deepEqual(extension.packageJSON.activationEvents, ['onStartupFinished']);
    await extension.activate();
    assert.equal(extension.isActive, true);
    assert.deepEqual(shown, []);
  });

  test('allows clipcmd:// terminal links so a click does not prompt', async () => {
    const read = () => vscode.workspace.getConfiguration('terminal.integrated').get<string[]>('allowedLinkSchemes') ?? [];
    // Written asynchronously during activation
    const deadline = Date.now() + 10000;
    while (!read().includes('clipcmd') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const schemes = read();
    assert.ok(schemes.includes('clipcmd'), `allowedLinkSchemes: ${JSON.stringify(schemes)}`);
    // The defaults are kept
    assert.ok(schemes.includes('https') && schemes.includes('vscode'));
  });

  test("sends each command's output from a real terminal to the daemon", async function () {
    this.timeout(90000);
    const received: Array<{ url: string; body: string }> = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body });
        // Like the daemon: /end answers with the buttons (none here), a hook prints the body
        res.end(req.url?.startsWith('/end') ? '' : 'OK');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(portFile(), `${(server.address() as net.AddressInfo).port}:${process.pid}`);

    // Point any clipcmd hook in the user's shell config at this test's config
    // dir, never at a real daemon (VS Code only injects its shell integration
    // for standard shell launches, so the config cannot be skipped).
    const { shellPath, command } = terminalShell();
    const terminal = vscode.window.createTerminal({
      name: 'clipcmd-test',
      shellPath,
      env: { CLIPCMD_CONFIG_DIR: path.dirname(portFile()), CLIPCMD_AUTOSHELL: '0', CLIPCMD_AUTOSTART: '0' },
    });
    try {
      const integration = await new Promise<vscode.TerminalShellIntegration>((resolve, reject) => {
        if (terminal.shellIntegration) return resolve(terminal.shellIntegration);
        const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
          if (e.terminal === terminal) {
            sub.dispose();
            resolve(e.shellIntegration);
          }
        });
        setTimeout(() => reject(new Error('shell integration did not start')), 45000);
      });
      integration.executeCommand(command);
      const deadline = Date.now() + 30000;
      while (!received.some((r) => r.url.startsWith('/output')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const output = received.find((r) => r.url.startsWith('/output'));
      assert.ok(output, `no /output request, got ${JSON.stringify(received)}`);
      const query = new URL(output.url, 'http://x').searchParams;
      assert.equal(query.get('cmd'), command);
      assert.equal(query.get('sid'), String(await terminal.processId));
      assert.equal(output.body, 'progress 100%\nsecond line');
    } finally {
      terminal.dispose();
    }
  });

  test('contributes its commands and settings', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const contributed = extension.packageJSON.contributes.commands as Array<{ command: string; category?: string }>;
    assert.deepEqual(
      contributed.map((c) => `${c.category}: ${c.command}`),
      [`clipcmd: ${COMMAND}`, `clipcmd: ${START_COMMAND}`]
    );
    const settings = extension.packageJSON.contributes.configuration.properties;
    // A workspace must not be able to choose what "Start Daemon" runs
    assert.equal(settings['clipcmd.cliPath'].scope, 'machine');
  });

  test('running the command activates the extension and reports a missing daemon', async () => {
    const status = await check();
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)!.isActive, true);
    assert.equal(status.state, 'not-running');
    assert.deepEqual(shown, [{ level: 'warning', message: status.message, items: ['Start Daemon'] }]);
    assert.ok((await vscode.commands.getCommands(true)).includes(COMMAND));
  });

  test('reports a running daemon as an information message', async () => {
    const port = await fakeDaemon();
    fs.writeFileSync(portFile(), `${port}:${process.pid}`);
    const status = await check();
    assert.equal(status.state, 'running');
    assert.equal(status.port, port);
    assert.deepEqual(shown, [
      { level: 'info', message: `clipcmd daemon is running on port ${port} (PID ${process.pid}).`, items: [] },
    ]);
  });

  test('reports a crashed daemon (stale port file) as a warning', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
    fs.writeFileSync(portFile(), `9:${dead}`);
    const status = await check();
    assert.equal(status.state, 'stale');
    assert.equal(shown[0].level, 'warning');
    assert.match(shown[0].message, new RegExp(`PID ${dead} from its port file has exited`));
    assert.deepEqual(shown[0].items, ['Start Daemon']);
  });

  test('reports a foreign program on the port as a warning', async () => {
    const port = await fakeDaemon(404, 'Not Found');
    fs.writeFileSync(portFile(), `${port}:${process.pid}`);
    assert.equal((await check()).state, 'not-clipcmd');
    assert.equal(shown[0].level, 'warning');
    assert.deepEqual(shown[0].items, []); // starting another daemon would not free the port
  });

  test('handles a corrupt port file gracefully', async () => {
    fs.writeFileSync(portFile(), '\0garbage');
    assert.equal((await check()).state, 'invalid-port-file');
    assert.equal(shown[0].level, 'warning');
  });

  test('Start Daemon runs `clipcmd start` and reports what it printed', async () => {
    const dir = path.join(scratch, 'ok');
    await setCliPath(fakeCli(dir, 'Daemon started on port 9666 (PID 42)'));
    const result = (await vscode.commands.executeCommand<StartResult>(START_COMMAND)) as StartResult;
    assert.deepEqual(result, { ok: true, message: 'Daemon started on port 9666 (PID 42)' });
    assert.equal(fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim(), 'start');
    assert.deepEqual(shown, [{ level: 'info', message: result.message, items: [] }]);
  });

  test('clicking "Start Daemon" on the warning starts the daemon', async () => {
    const dir = path.join(scratch, 'click');
    await setCliPath(fakeCli(dir, 'Daemon started on port 9666 (PID 42)'));
    choice = 'Start Daemon';
    await check();
    await waitUntil(() => fs.existsSync(path.join(dir, 'args.txt')));
    await waitUntil(() => shown.some((s) => s.level === 'info'));
    assert.equal(shown[1].message, 'Daemon started on port 9666 (PID 42)');
  });

  test('explains how to install clipcmd when the CLI is missing', async () => {
    await setCliPath(path.join(scratch, 'missing', process.platform === 'win32' ? 'clipcmd.cmd' : 'clipcmd'));
    const result = (await vscode.commands.executeCommand<StartResult>(START_COMMAND)) as StartResult;
    assert.equal(result.ok, false);
    assert.match(result.message, /npm install -g clipcmd/);
    assert.deepEqual(shown, [{ level: 'warning', message: result.message, items: ['How to Install'] }]);
  });

  test('reports why `clipcmd start` failed', async () => {
    await setCliPath(fakeCli(path.join(scratch, 'fail'), 'Daemon failed to start', 1));
    const result = (await vscode.commands.executeCommand<StartResult>(START_COMMAND)) as StartResult;
    assert.equal(result.ok, false);
    assert.match(result.message, /Daemon failed to start/);
    assert.equal(shown[0].level, 'warning');
  });

  test('never produces error notifications for any daemon state', () => {
    assert.ok(allShown.length >= 5, 'earlier tests showed notifications');
    assert.ok(!allShown.some((s) => s.level === 'error'));
  });
});
