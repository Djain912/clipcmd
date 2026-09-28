import * as assert from 'node:assert/strict';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkHealth,
  getConfigDir,
  getDaemonPortInfo,
  getDaemonStatus,
  getPortFilePath,
  isProcessAlive,
  parsePortFile,
  readPortFile,
} from '../../daemonClient';

/** A pid that is guaranteed to be dead. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid as number;
}

/** Starts a throwaway HTTP/TCP server on 127.0.0.1 and returns its port. */
async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function jsonServer(status: number, body: string, delayMs = 0): http.Server {
  return http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    }, delayMs);
  });
}

suite('daemonClient', () => {
  let dir: string;
  let portFile: string;
  const servers: net.Server[] = [];
  const saved = process.env.CLIPCMD_CONFIG_DIR;

  const sockets = new Set<net.Socket>();

  async function serve(server: net.Server): Promise<number> {
    servers.push(server);
    // close() waits for open connections; track them so teardown can end them
    server.on('connection', (socket: net.Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    return listen(server);
  }

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcmd-ext-'));
    portFile = path.join(dir, 'port');
  });

  teardown(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
  });

  suite('config location', () => {
    test('defaults to ~/.config/clipcmd/port', () => {
      assert.equal(getPortFilePath({}), path.join(os.homedir(), '.config', 'clipcmd', 'port'));
    });

    test('honours CLIPCMD_CONFIG_DIR (read on every call), ignoring blank values', () => {
      assert.equal(getConfigDir({ CLIPCMD_CONFIG_DIR: dir }), dir);
      assert.equal(getPortFilePath({ CLIPCMD_CONFIG_DIR: dir }), portFile);
      assert.equal(getConfigDir({ CLIPCMD_CONFIG_DIR: '  ' }), path.join(os.homedir(), '.config', 'clipcmd'));
      process.env.CLIPCMD_CONFIG_DIR = dir;
      assert.equal(getPortFilePath(), portFile);
    });
  });

  suite('parsePortFile', () => {
    const valid: Array<[string, { port: number; pid?: number }]> = [
      ['9666:21324', { port: 9666, pid: 21324 }],
      ['9666', { port: 9666, pid: undefined }],
      [' 9666:1\r\n', { port: 9666, pid: 1 }],
      ['﻿9667:5', { port: 9667, pid: 5 }],
      ['65535:0', { port: 65535, pid: undefined }],
    ];
    for (const [content, expected] of valid) {
      test(`parses ${JSON.stringify(content)}`, () => assert.deepEqual(parsePortFile(content), expected));
    }

    const invalid = ['', 'garbage', '0', '0:12', '65536', '70000:1', '-1', '9666:', ':12', '9666:1:2', '9666:x', '96 66', '1e3'];
    for (const content of invalid) {
      test(`rejects ${JSON.stringify(content)}`, () => assert.equal(parsePortFile(content), undefined));
    }
  });

  suite('readPortFile', () => {
    test('missing file, or a file where the directory should be', () => {
      assert.deepEqual(readPortFile(portFile), { kind: 'missing' });
      fs.writeFileSync(path.join(dir, 'notadir'), '');
      assert.deepEqual(readPortFile(path.join(dir, 'notadir', 'port')), { kind: 'missing' });
    });

    test('a directory in place of the file is unreadable, not a crash', () => {
      fs.mkdirSync(portFile);
      assert.equal(readPortFile(portFile).kind, 'unreadable');
      assert.equal(getDaemonPortInfo(portFile), undefined);
    });

    test('invalid and valid content', () => {
      fs.writeFileSync(portFile, 'nope');
      assert.deepEqual(readPortFile(portFile), { kind: 'invalid' });
      fs.writeFileSync(portFile, '4000:77');
      assert.deepEqual(readPortFile(portFile), { kind: 'ok', port: 4000, pid: 77 });
      assert.deepEqual(getDaemonPortInfo(portFile), { port: 4000, pid: 77 });
    });
  });

  test('isProcessAlive', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(deadPid()), false);
  });

  suite('checkHealth', () => {
    test('accepts only {"status":"ok"} with HTTP 200', async () => {
      assert.deepEqual(await checkHealth(await serve(jsonServer(200, '{"status":"ok"}'))), { kind: 'ok' });
      assert.deepEqual(await checkHealth(await serve(jsonServer(200, '{"status":"starting"}'))), {
        kind: 'unexpected',
        statusCode: 200,
      });
      assert.deepEqual(await checkHealth(await serve(jsonServer(200, '<html>hi</html>'))), {
        kind: 'unexpected',
        statusCode: 200,
      });
      assert.deepEqual(await checkHealth(await serve(jsonServer(200, 'null'))), { kind: 'unexpected', statusCode: 200 });
      assert.deepEqual(await checkHealth(await serve(jsonServer(404, 'Not Found'))), {
        kind: 'unexpected',
        statusCode: 404,
      });
      assert.deepEqual(await checkHealth(await serve(jsonServer(500, '{"status":"ok"}'))), {
        kind: 'unexpected',
        statusCode: 500,
      });
    });

    test('a slow but in-time answer is ok', async () => {
      assert.deepEqual(await checkHealth(await serve(jsonServer(200, '{"status":"ok"}', 300)), 2000), { kind: 'ok' });
    });

    test('times out on a server that accepts but never answers', async () => {
      const port = await serve(net.createServer(() => {}));
      const started = Date.now();
      assert.deepEqual(await checkHealth(port, 300), { kind: 'timeout' });
      assert.ok(Date.now() - started < 1500, 'honours the timeout');
    });

    test('refused connection is unreachable', async () => {
      assert.deepEqual(await checkHealth(await closedPort(), 5000), { kind: 'unreachable' });
    });

    test('socket destroyed on connect is unreachable', async () => {
      const port = await serve(net.createServer((socket) => socket.destroy()));
      assert.deepEqual(await checkHealth(port), { kind: 'unreachable' });
    });

    test('connection dropped mid-body resolves instead of hanging', async () => {
      const port = await serve(
        net.createServer((socket) => {
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{"status":');
          setTimeout(() => socket.destroy(), 50);
        })
      );
      assert.deepEqual(await checkHealth(port, 3000), { kind: 'unreachable' });
    });

    test('garbage instead of HTTP is unreachable', async () => {
      const port = await serve(net.createServer((socket) => socket.end('SSH-2.0-OpenSSH\r\n')));
      assert.deepEqual(await checkHealth(port, 3000), { kind: 'unreachable' });
    });

    test('an oversized body is rejected without buffering it all', async () => {
      const big = 'x'.repeat(5 * 1024 * 1024);
      assert.deepEqual(await checkHealth(await serve(jsonServer(200, big))), { kind: 'unexpected', statusCode: 200 });
    });
  });

  suite('getDaemonStatus', () => {
    test('no port file → not-running with a start hint', async () => {
      const status = await getDaemonStatus({ portFile });
      assert.equal(status.state, 'not-running');
      assert.equal(status.available, false);
      assert.match(status.message, /clipcmd start/);
    });

    test('malformed port file → invalid-port-file', async () => {
      fs.writeFileSync(portFile, 'not-a-port');
      const status = await getDaemonStatus({ portFile });
      assert.equal(status.state, 'invalid-port-file');
      assert.ok(status.message.includes(portFile));
    });

    test('unreadable port file → invalid-port-file, no throw', async () => {
      fs.mkdirSync(portFile);
      const status = await getDaemonStatus({ portFile });
      assert.equal(status.state, 'invalid-port-file');
      assert.match(status.message, /Cannot read/);
    });

    test('dead pid → stale, answered instantly without any HTTP request', async () => {
      let connected = false;
      const port = await serve(net.createServer(() => (connected = true)));
      const pid = deadPid();
      fs.writeFileSync(portFile, `${port}:${pid}`);
      const started = Date.now();
      const status = await getDaemonStatus({ portFile });
      assert.deepEqual(
        { state: status.state, port: status.port, pid: status.pid },
        { state: 'stale', port, pid }
      );
      assert.ok(status.message.includes(`PID ${pid}`));
      assert.ok(Date.now() - started < 500);
      assert.equal(connected, false);
    });

    test('healthy daemon → running with port and pid', async () => {
      const port = await serve(jsonServer(200, '{"status":"ok"}'));
      fs.writeFileSync(portFile, `${port}:${process.pid}`);
      const status = await getDaemonStatus({ portFile });
      assert.deepEqual(status, {
        available: true,
        state: 'running',
        port,
        pid: process.pid,
        message: `clipcmd daemon is running on port ${port} (PID ${process.pid}).`,
      });
    });

    test('legacy port file without pid → running without a pid', async () => {
      const port = await serve(jsonServer(200, '{"status":"ok"}'));
      fs.writeFileSync(portFile, String(port));
      const status = await getDaemonStatus({ portFile });
      assert.equal(status.state, 'running');
      assert.equal(status.pid, undefined);
      assert.equal(status.message, `clipcmd daemon is running on port ${port}.`);
    });

    test('pid alive but nothing listening → unreachable', async () => {
      const port = await closedPort();
      fs.writeFileSync(portFile, `${port}:${process.pid}`);
      const status = await getDaemonStatus({ portFile, timeoutMs: 5000 });
      assert.equal(status.state, 'unreachable');
      assert.ok(status.message.includes(String(port)));
    });

    test('hung daemon → timeout', async () => {
      const port = await serve(net.createServer(() => {}));
      fs.writeFileSync(portFile, `${port}:${process.pid}`);
      assert.equal((await getDaemonStatus({ portFile, timeoutMs: 300 })).state, 'timeout');
    });

    test('another program on the port → not-clipcmd', async () => {
      const port = await serve(jsonServer(404, 'Not Found'));
      fs.writeFileSync(portFile, `${port}:${process.pid}`);
      const status = await getDaemonStatus({ portFile });
      assert.equal(status.state, 'not-clipcmd');
      assert.match(status.message, /HTTP 404/);
    });

    test('uses CLIPCMD_CONFIG_DIR when no port file is given', async () => {
      const port = await serve(jsonServer(200, '{"status":"ok"}'));
      fs.writeFileSync(portFile, `${port}:${process.pid}`);
      process.env.CLIPCMD_CONFIG_DIR = dir;
      assert.equal((await getDaemonStatus()).state, 'running');
    });

    test('never throws, whatever the port file contains', async () => {
      const samples = ['', '\0\0\0', '9'.repeat(400), '1:', 'ñ', '8080:-1', '8080:99999999999', '\n\n', '{"port":1}'];
      for (let i = 0; i < 40; i++) {
        samples.push(Array.from({ length: i % 12 }, () => String.fromCharCode(Math.floor(Math.random() * 128))).join(''));
      }
      for (const content of samples) {
        fs.writeFileSync(portFile, content);
        const status = await getDaemonStatus({ portFile, timeoutMs: 300, isProcessAlive: () => false });
        assert.equal(typeof status.message, 'string');
        assert.equal(status.available, false);
      }
    });
  });

  /**
   * Against the real daemon from the clipcmd CLI project, when available:
   * CLIPCMD_DAEMON_ENTRY=<clipcmd>/dist/daemon/index.js npm run test:unit
   */
  suite('against the real clipcmd daemon', function () {
    const entry = process.env.CLIPCMD_DAEMON_ENTRY;
    let child: ChildProcess | undefined;

    suiteSetup(function () {
      if (!entry || !fs.existsSync(entry)) this.skip();
    });

    teardown(() => {
      if (child?.pid && isProcessAlive(child.pid)) child.kill();
      child = undefined;
    });

    async function startDaemon(): Promise<{ port: number; pid: number }> {
      const port = await closedPort();
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }));
      child = spawn(process.execPath, [entry as string], {
        env: { ...process.env, CLIPCMD_CONFIG_DIR: dir },
        stdio: 'ignore',
      });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const info = getDaemonPortInfo(portFile);
        if (info && info.pid !== undefined && info.pid === child.pid) return { port: info.port, pid: info.pid };
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('daemon did not start');
    }

    test('running → shut down cleanly → not-running', async () => {
      const { port, pid } = await startDaemon();
      const running = await getDaemonStatus({ portFile });
      assert.deepEqual({ state: running.state, port: running.port, pid: running.pid }, { state: 'running', port, pid });

      await new Promise<void>((resolve) => http.get(`http://127.0.0.1:${port}/shutdown`, (res) => (res.resume(), resolve())));
      const deadline = Date.now() + 5000;
      while (fs.existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.equal((await getDaemonStatus({ portFile })).state, 'not-running');
    });

    test('crashed daemon → stale', async () => {
      const { pid } = await startDaemon();
      process.kill(pid, 'SIGKILL');
      const deadline = Date.now() + 5000;
      while (isProcessAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.equal((await getDaemonStatus({ portFile })).state, 'stale');
    });
  });
});
