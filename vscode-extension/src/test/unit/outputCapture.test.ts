import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { announceToDaemon, captureTerminalOutput, cleanTerminalOutput } from '../../outputCapture';

const ESC = '\x1b';
const BEL = '\x07';
const BUTTONS =
  `${ESC}]8;;clipcmd://copy?id=1&type=cmd${BEL}[COPY CMD]${ESC}]8;;${BEL} ` +
  `${ESC}]8;;clipcmd://copy?id=1&type=output${BEL}[COPY OUTPUT]${ESC}]8;;${BEL} ` +
  `${ESC}]8;;clipcmd://copy?id=1&type=both${BEL}[COPY BOTH]${ESC}]8;;${BEL} ` +
  `${ESC}]8;;clipcmd://select?id=1${BEL}[+]${ESC}]8;;${BEL}\n`;

suite('cleanTerminalOutput', () => {
  test('what VS Code hands over for a PowerShell command', () => {
    assert.equal(cleanTerminalOutput(`${ESC}]633;C${BEL}hello world\r\n`), 'hello world');
  });

  test('drops colors, keeps text', () => {
    assert.equal(cleanTerminalOutput(`${ESC}]633;C${BEL}${ESC}[0;91m${ESC}[0;91mred${ESC}[0m${ESC}[0m\r\nplain\r\n`), 'red\nplain');
  });

  test("drops clipcmd's own button line and hint", () => {
    assert.equal(cleanTerminalOutput(`out\r\n${BUTTONS}`), 'out');
    assert.equal(
      cleanTerminalOutput(`out\r\n${BUTTONS}${ESC}[2mclipcmd: install the clipcmd VS Code extension to also copy command output here.${ESC}[0m\n`),
      'out'
    );
    // Only at the end: a command that prints such text keeps it
    assert.equal(cleanTerminalOutput('[COPY CMD] [+]\r\nreal output\r\n'), '[COPY CMD] [+]\nreal output');
  });

  test('carriage returns overwrite the line: progress bars keep their final state', () => {
    assert.equal(cleanTerminalOutput('progress 10%\rprogress 55%\rprogress 100%\r\ndone\r\n'), 'progress 100%\ndone');
    assert.equal(cleanTerminalOutput('abcdef\rXY\n'), 'XYcdef');
  });

  test('keeps inner blank lines, trims surrounding ones and trailing spaces', () => {
    assert.equal(cleanTerminalOutput('\r\n\r\na   \r\n\r\nb\r\n\r\n'), 'a\n\nb');
    assert.equal(cleanTerminalOutput(''), '');
    assert.equal(cleanTerminalOutput(`${ESC}]633;C${BEL}`), '');
  });

  test('keeps tabs and unicode', () => {
    assert.equal(cleanTerminalOutput('a\tb héllo 🚀\r\n'), 'a\tb héllo 🚀');
  });
});

suite('captureTerminalOutput', () => {
  function fakeWindow() {
    let listener: ((e: unknown) => unknown) | undefined;
    return {
      window: {
        onDidStartTerminalShellExecution: (l: (e: unknown) => unknown) => {
          listener = l;
          return { dispose: () => (listener = undefined) };
        },
      },
      start: (cmd: string, chunks: string[], pid: number | 'none' = 4242) =>
        listener?.({
          terminal: { processId: Promise.resolve(pid === 'none' ? undefined : pid) },
          execution: {
            commandLine: { value: cmd },
            read: async function* () {
              for (const chunk of chunks) yield chunk;
            },
          },
        }),
    };
  }

  test('sends each command with its cleaned output and the shell pid', async () => {
    const fake = fakeWindow();
    const sent: unknown[][] = [];
    const disposable = captureTerminalOutput({ window: fake.window as never, send: (...args) => sent.push(args) });
    await fake.start("Write-Output 'hi' ", [`${ESC}]633;C${BEL}h`, 'i\r\n', BUTTONS]);
    assert.deepEqual(sent, [['4242', "Write-Output 'hi'", 'hi']]);
    await fake.start('   ', ['x']); // no command line: nothing to attach to
    await fake.start('ls', ['a\r\n'], 'none');
    assert.deepEqual(sent[1], [undefined, 'ls', 'a']);
    disposable.dispose();
  });
});

suite('talking to the daemon', () => {
  let dir: string;
  let server: http.Server;
  let requests: Array<{ method?: string; url?: string; body: string }>;
  const saved = process.env.CLIPCMD_CONFIG_DIR;

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcmd-ext-cap-'));
    process.env.CLIPCMD_CONFIG_DIR = dir;
    requests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body });
        res.end('OK');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(dir, 'port'), `${(server.address() as net.AddressInfo).port}:${process.pid}`);
  });

  teardown(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
  });

  const waitForRequests = async (n: number) => {
    const deadline = Date.now() + 5000;
    while (requests.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  };

  test('announces the VS Code extension', async () => {
    announceToDaemon();
    await waitForRequests(1);
    assert.deepEqual(requests, [{ method: 'GET', url: '/client?kind=vscode', body: '' }]);
  });

  test('POSTs captured output with the command and session', async () => {
    let listener: ((e: unknown) => unknown) | undefined;
    const window = { onDidStartTerminalShellExecution: (l: (e: unknown) => unknown) => ((listener = l), { dispose() {} }) };
    captureTerminalOutput({ window: window as never });
    await listener?.({
      terminal: { processId: Promise.resolve(99) },
      execution: { commandLine: { value: 'npm test' }, read: async function* () { yield 'passed ✓\r\n'; } },
    });
    await waitForRequests(1);
    assert.deepEqual(requests, [{ method: 'POST', url: '/output?cmd=npm+test&sid=99', body: 'passed ✓' }]);
  });

  test('stays silent when no daemon is registered', async () => {
    fs.rmSync(path.join(dir, 'port'));
    announceToDaemon();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(requests, []);
  });
});
