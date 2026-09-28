import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DaemonStatus } from '../../daemonClient';

const EXTENSION_ID = 'local.clipcmd-vscode';
const COMMAND = 'clipcmd.checkDaemon';

/** Records notifications instead of showing them (they would otherwise pile up). */
const shown: Array<{ level: 'info' | 'warning' | 'error'; message: string }> = [];
/** Every notification of the whole run (`shown` is reset per test). */
const allShown: typeof shown = [];
const originals = {
  info: vscode.window.showInformationMessage,
  warning: vscode.window.showWarningMessage,
  error: vscode.window.showErrorMessage,
};

function stubNotifications(): void {
  const record =
    (level: 'info' | 'warning' | 'error') =>
    (message: string): Thenable<undefined> => {
      shown.push({ level, message });
      allShown.push({ level, message });
      return Promise.resolve(undefined);
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

suite('clipcmd extension (in VS Code)', () => {
  let server: http.Server | undefined;

  suiteSetup(() => stubNotifications());

  suiteTeardown(() => {
    Object.assign(vscode.window as unknown as Record<string, unknown>, {
      showInformationMessage: originals.info,
      showWarningMessage: originals.warning,
      showErrorMessage: originals.error,
    });
  });

  setup(() => {
    shown.length = 0;
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

    // Point any clipcmd hook in the user's profile at this test's config dir,
    // never at a real daemon (VS Code only injects its shell integration for
    // standard PowerShell launches, so the profile cannot be skipped).
    const terminal = vscode.window.createTerminal({
      name: 'clipcmd-test',
      shellPath: 'powershell.exe',
      env: { CLIPCMD_CONFIG_DIR: path.dirname(portFile()), CLIPCMD_AUTOSHELL: '0' },
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
      integration.executeCommand("Write-Host 'progress 5%' -NoNewline; Write-Host \"`rprogress 100%\"; 'second line'");
      const deadline = Date.now() + 30000;
      while (!received.some((r) => r.url.startsWith('/output')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const output = received.find((r) => r.url.startsWith('/output'));
      assert.ok(output, `no /output request, got ${JSON.stringify(received)}`);
      const query = new URL(output.url, 'http://x').searchParams;
      assert.equal(query.get('cmd'), "Write-Host 'progress 5%' -NoNewline; Write-Host \"`rprogress 100%\"; 'second line'");
      assert.equal(query.get('sid'), String(await terminal.processId));
      assert.equal(output.body, 'progress 100%\nsecond line');
    } finally {
      terminal.dispose();
    }
  });

  test('contributes the command to the command palette', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const contributed = extension.packageJSON.contributes.commands as Array<{ command: string; category?: string }>;
    assert.deepEqual(
      contributed.map((c) => `${c.category}: ${c.command}`),
      [`clipcmd: ${COMMAND}`]
    );
  });

  test('running the command activates the extension and reports a missing daemon', async () => {
    const status = await check();
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)!.isActive, true);
    assert.equal(status.state, 'not-running');
    assert.deepEqual(shown, [{ level: 'warning', message: status.message }]);
    assert.ok((await vscode.commands.getCommands(true)).includes(COMMAND));
  });

  test('reports a running daemon as an information message', async () => {
    const port = await fakeDaemon();
    fs.writeFileSync(portFile(), `${port}:${process.pid}`);
    const status = await check();
    assert.equal(status.state, 'running');
    assert.equal(status.port, port);
    assert.deepEqual(shown, [
      { level: 'info', message: `clipcmd daemon is running on port ${port} (PID ${process.pid}).` },
    ]);
  });

  test('reports a crashed daemon (stale port file) as a warning', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
    fs.writeFileSync(portFile(), `9:${dead}`);
    const status = await check();
    assert.equal(status.state, 'stale');
    assert.equal(shown[0].level, 'warning');
    assert.match(shown[0].message, new RegExp(`PID ${dead} from its port file has exited`));
  });

  test('reports a foreign program on the port as a warning', async () => {
    const port = await fakeDaemon(404, 'Not Found');
    fs.writeFileSync(portFile(), `${port}:${process.pid}`);
    assert.equal((await check()).state, 'not-clipcmd');
    assert.equal(shown[0].level, 'warning');
  });

  test('handles a corrupt port file gracefully', async () => {
    fs.writeFileSync(portFile(), '\0garbage');
    assert.equal((await check()).state, 'invalid-port-file');
    assert.equal(shown[0].level, 'warning');
  });

  test('never produces error notifications for any daemon state', () => {
    assert.ok(allShown.length >= 5, 'earlier tests showed notifications');
    assert.ok(!allShown.some((s) => s.level === 'error'));
  });
});
