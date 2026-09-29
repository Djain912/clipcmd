import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildButtonsString } from '../osc8';
import { urlScheme } from '../../installer/protocolHandler';
import { DaemonServer } from '../server';
import { RingBuffer } from '../ringBuffer';
import { MultiSelectQueue } from '../multiSelectQueue';
import { FileTailCapture } from '../capture';
import { readPortFile, writePortFile } from '../../config/portFile';
import {
  FakeClipboard,
  makeTempDir,
  occupyPort,
  qs,
  removeDir,
  request,
  startTestDaemon,
  TestDaemon,
} from '../../../test/helpers';

describe('DaemonServer HTTP API', () => {
  let dir: string;
  let d: TestDaemon;
  const get = (p: string, headers?: Record<string, string>) => request(d.port, p, { headers });

  /** Runs one /start → /end cycle and returns the /end response. */
  async function runCommand(cmd: string, opts: { exitCode?: number | string; sid?: string; output?: string } = {}) {
    const sid = opts.sid ?? 'default';
    const start = await get(`/start?${qs({ cmd, pwd: '/home/u', ...(opts.sid ? { sid } : {}) })}`);
    expect(start.status).toBe(200);
    if (opts.output !== undefined) {
      fs.mkdirSync(d.sessionsDir, { recursive: true });
      fs.appendFileSync(path.join(d.sessionsDir, `${sid}.log`), opts.output, 'utf8');
    }
    return get(`/end?${qs({ exitCode: String(opts.exitCode ?? 0), ...(opts.sid ? { sid } : {}) })}`);
  }

  const lastBlock = () => {
    const all = d.ringBuffer.getAll();
    return all[all.length - 1];
  };

  beforeEach(async () => {
    dir = makeTempDir();
    d = await startTestDaemon({ configDir: dir, ringBufferSize: 5 });
  });
  afterEach(async () => {
    await d.stop();
    removeDir(dir);
  });

  describe('routing and request validation', () => {
    it('GET /health returns {"status":"ok"} as JSON', async () => {
      const res = await get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toBe('{"status":"ok"}');
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each(['/', '/nope', '/health/extra', '/HEALTH'])('unknown route %s → 404', async (p) => {
      expect((await get(p)).status).toBe(404);
    });

    it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('%s → 405 with Allow: GET', async (method) => {
      const res = await request(d.port, '/health', { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET');
    });

    it('rejects duplicate query parameters', async () => {
      const res = await get('/copy?id=a&id=b&type=cmd');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Duplicate query parameter: id');
    });

    it('answers a malformed request line without crashing', async () => {
      const raw = await new Promise<string>((resolve) => {
        const socket = net.connect(d.port, '127.0.0.1', () => socket.write('GET http://[bad HTTP/1.1\r\nHost: x\r\n\r\n'));
        let data = '';
        socket.on('data', (c) => (data += c));
        socket.on('close', () => resolve(data));
        socket.on('error', () => resolve(data));
        setTimeout(() => socket.destroy(), 1000);
      });
      expect(raw).toMatch(/^HTTP\/1\.1 4\d\d/);
      expect((await get('/health')).status).toBe(200);
    });
  });

  describe('browser request protection (CSRF / DNS rebinding)', () => {
    it.each([
      [{ Host: 'evil.example' }, 'Host'],
      [{ Host: 'evil.example:1234' }, 'Host'],
      [{ Origin: 'https://evil.example' }, 'cross-origin'],
      [{ Origin: 'null' }, 'cross-origin'],
      [{ 'Sec-Fetch-Site': 'cross-site' }, 'web pages'],
      [{ 'Sec-Fetch-Site': 'same-site' }, 'web pages'],
      [{ 'Sec-Fetch-Site': 'same-origin' }, 'web pages'],
    ])('rejects %j with 403', async (headers, reason) => {
      const res = await get('/shutdown', headers);
      expect(res.status).toBe(403);
      expect(res.body).toContain(reason);
      expect((await get('/health')).status).toBe(200); // still running
    });

    it('allows a user clicking an OSC 8 link (top-level navigation, Sec-Fetch-Site: none)', async () => {
      await runCommand('ls');
      const res = await get(`/copy?id=${lastBlock().id}&type=cmd`, {
        Host: `localhost:${d.port}`,
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
      });
      expect(res.status).toBe(200);
      expect(d.clipboard.last).toBe('ls');
    });
  });

  describe('/start and /end', () => {
    it('records a block and returns the OSC 8 buttons for it', async () => {
      const res = await runCommand('ls -la', { exitCode: 3 });
      expect(res.status).toBe(200);
      const block = lastBlock();
      expect(block).toMatchObject({ command: 'ls -la', pwd: '/home/u', exitCode: 3, inProgress: false, output: '' });
      // No output capture in this session: only [COPY CMD] [+], plus a one-time hint
      expect(res.body.startsWith(buildButtonsString(block, d.port, { withOutput: false }))).toBe(true);
      expect(res.body).toContain('clipcmd shell');
      const second = await runCommand('pwd');
      expect(second.body).toBe(buildButtonsString(lastBlock(), d.port, { withOutput: false }));
    });

    it('shows all four buttons when the session is captured (clipcmd shell)', async () => {
      fs.mkdirSync(d.sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(d.sessionsDir, 'wrapped.log'), '');
      const res = await runCommand('ls', { sid: 'wrapped' });
      expect(res.body).toBe(buildButtonsString(lastBlock(), d.port, { withOutput: true }));
    });

    it('shows all four buttons in VS Code only while its extension checks in', async () => {
      let now = 1_000_000;
      const vs = await startTestDaemon({ configDir: dir, now: () => now });
      try {
        const cmd = async () => {
          await request(vs.port, `/start?${qs({ cmd: 'ls', pwd: '/', sid: 'v1', term: 'vscode' })}`);
          return (await request(vs.port, '/end?exitCode=0&sid=v1')).body;
        };
        expect(await cmd()).toContain('install the clipcmd VS Code extension');
        expect((await request(vs.port, '/client?kind=vscode')).status).toBe(200);
        expect(await cmd()).toContain('[COPY OUTPUT]');
        now += 6 * 60 * 1000; // extension went away
        expect(await cmd()).not.toContain('[COPY OUTPUT]');
      } finally {
        await vs.stop();
      }
    });

    it('uses the link style chosen per command', async () => {
      let scheme: 'http' | 'clipcmd' = 'http';
      const ld = await startTestDaemon({ configDir: dir, linkScheme: () => scheme });
      try {
        await request(ld.port, `/start?${qs({ cmd: 'ls', pwd: '/' })}`);
        expect((await request(ld.port, '/end?exitCode=0')).body).toContain(`http://127.0.0.1:${ld.port}/copy?`);
        scheme = 'clipcmd';
        await request(ld.port, `/start?${qs({ cmd: 'ls', pwd: '/' })}`);
        expect((await request(ld.port, '/end?exitCode=0')).body).toContain(`${urlScheme()}://copy?id=`);
      } finally {
        await ld.stop();
      }
    });

    it('rejects an invalid term', async () => {
      expect((await get(`/start?${qs({ cmd: 'ls', pwd: '/', term: 'Bad Term' })}`)).status).toBe(400);
    });

    it('does not double-decode: %, +, & and = survive (regression)', async () => {
      for (const cmd of ["printf '%41 100%'", 'echo a+b', 'curl "x?a=1&b=2"', 'echo %E2%82%AC', '%']) {
        await runCommand(cmd);
        expect(lastBlock().command).toBe(cmd);
      }
    });

    it('stores any command string exactly (unicode, newlines, tabs, ANSI)', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, unit: 'grapheme' }), async (cmd) => {
          await runCommand(cmd);
          expect(lastBlock().command).toBe(cmd);
        }),
        { numRuns: 40 }
      );
    });

    it.each([
      [{ pwd: '/' }, 'cmd and pwd'],
      [{ cmd: 'ls' }, 'cmd and pwd'],
      [{ cmd: '', pwd: '/' }, 'cmd and pwd'],
      [{ cmd: 'ls', pwd: '/', sid: '../../etc' }, 'Invalid sid'],
      [{ cmd: 'ls', pwd: '/', sid: 'x'.repeat(65) }, 'Invalid sid'],
    ])('/start with %j → 400', async (params, message) => {
      const res = await get(`/start?${qs(params as Record<string, string>)}`);
      expect(res.status).toBe(400);
      expect(res.body).toContain(message);
    });

    it.each(['', 'abc', '1.5', '12abc', '0x1', ' 1', '99999999999'])('/end with exitCode=%j → 400', async (code) => {
      await get(`/start?${qs({ cmd: 'ls', pwd: '/' })}`);
      const res = await get(`/end?${qs({ exitCode: code })}`);
      expect(res.status).toBe(400);
    });

    it('/end without exitCode → 400', async () => {
      expect((await get('/end')).status).toBe(400);
    });

    it('accepts negative exit codes', async () => {
      await runCommand('x', { exitCode: -1 });
      expect(lastBlock().exitCode).toBe(-1);
    });

    it('/end with nothing in progress returns 200 with an empty body', async () => {
      const res = await get('/end?exitCode=0');
      expect(res.status).toBe(200);
      expect(res.body).toBe('');
      expect(d.ringBuffer.size).toBe(0);
    });

    it('a second /start finalizes the in-progress block with a null exit code (Req 3.6)', async () => {
      await get(`/start?${qs({ cmd: 'first', pwd: '/' })}`);
      await get(`/start?${qs({ cmd: 'second', pwd: '/' })}`);
      expect(d.ringBuffer.getAll().map((b) => [b.command, b.exitCode])).toEqual([['first', null]]);
      await get('/end?exitCode=0');
      expect(d.ringBuffer.getAll().map((b) => [b.command, b.exitCode])).toEqual([
        ['first', null],
        ['second', 0],
      ]);
    });

    it('keeps concurrent terminal sessions apart', async () => {
      await get(`/start?${qs({ cmd: 'in A', pwd: '/a', sid: 'A' })}`);
      await get(`/start?${qs({ cmd: 'in B', pwd: '/b', sid: 'B' })}`);
      await get(`/end?${qs({ exitCode: '1', sid: 'A' })}`);
      await get(`/end?${qs({ exitCode: '2', sid: 'B' })}`);
      expect(d.ringBuffer.getAll().map((b) => [b.command, b.exitCode])).toEqual([
        ['in A', 1],
        ['in B', 2],
      ]);
    });

    it('handles many sessions in parallel', async () => {
      const big = await startTestDaemon({ configDir: dir, ringBufferSize: 100 });
      try {
        await Promise.all(
          Array.from({ length: 40 }, async (_, i) => {
            const sid = `s${i}`;
            await request(big.port, `/start?${qs({ cmd: `cmd ${i}`, pwd: '/', sid })}`);
            await request(big.port, `/end?${qs({ exitCode: String(i), sid })}`);
          })
        );
        const blocks = big.ringBuffer.getAll();
        expect(blocks).toHaveLength(40);
        for (const b of blocks) expect(b.command).toBe(`cmd ${b.exitCode}`);
      } finally {
        await big.stop();
      }
    });

    it('finalizes the oldest session when too many are in progress', async () => {
      const small = await startTestDaemon({ configDir: dir, maxActiveSessions: 2 });
      try {
        for (const sid of ['a', 'b', 'c']) {
          await request(small.port, `/start?${qs({ cmd: sid, pwd: '/', sid })}`);
        }
        expect(small.ringBuffer.getAll().map((b) => b.command)).toEqual(['a']);
        expect((await request(small.port, '/end?exitCode=0&sid=a')).body).toBe('');
        expect((await request(small.port, '/end?exitCode=0&sid=c')).body).toContain('[COPY CMD]');
      } finally {
        await small.stop();
      }
    });

    it('attaches the session capture output to the block', async () => {
      await runCommand('make', { sid: 'tty1', output: 'building...\n\x1b[32mdone\x1b[0m\n' });
      expect(lastBlock().output).toBe('building...\n\x1b[32mdone\x1b[0m\n');
      await runCommand('other', { sid: 'tty2', output: 'second session' });
      expect(lastBlock().output).toBe('second session');
    });
  });

  describe('/copy', () => {
    it('[COPY BOTH] copies "$ command" and the output together', async () => {
      await runCommand('git status', { output: 'On branch main\nnothing to commit\n' });
      const res = await get(`/copy?id=${lastBlock().id}&type=both`);
      expect(res.body).toBe('Copied command and output to clipboard');
      expect(d.clipboard.last).toBe('$ git status\nOn branch main\nnothing to commit\n');
    });

    it('answers a browser (http links) with a page that closes itself', async () => {
      await runCommand('ls');
      const res = await get(`/copy?id=${lastBlock().id}&type=cmd`, {
        Accept: 'text/html,application/xhtml+xml',
        'Sec-Fetch-Site': 'none',
      });
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Copied command to clipboard');
      expect(res.body).toContain('window.close()');
      const missing = await get('/copy?id=nope&type=cmd', { Accept: 'text/html' });
      expect(missing.status).toBe(404);
      expect(missing.body).not.toContain('window.close()');
      expect(missing.body).not.toContain('<script>alert'); // escaped
    });

    it('copies the bare command and the raw output', async () => {
      await runCommand('echo hi', { output: 'hi\r\n' });
      const id = lastBlock().id;
      const cmd = await get(`/copy?id=${id}&type=cmd`);
      expect(cmd.status).toBe(200);
      expect(d.clipboard.last).toBe('echo hi');
      expect((await get(`/copy?id=${id}&type=output`)).status).toBe(200);
      expect(d.clipboard.last).toBe('hi\r\n');
    });

    it('responds within 50ms (Req 5.6 / 10.5)', async () => {
      await runCommand('ls');
      // Best of 5: other test files running in parallel can stall any single request
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        await get(`/copy?id=${lastBlock().id}&type=cmd`);
        times.push(performance.now() - started);
      }
      expect(Math.min(...times)).toBeLessThan(50);
    });

    // Feature: clipcmd, Property 6: Copy does not mutate output
    it('writes the output byte-for-byte (Property 6)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ unit: fc.constantFrom('a', ' ', '\t', '\n', '\r', '\x1b[1;31m', '\x1b[0m', 'é', '🚀', '%', '"') }),
          async (output) => {
            await runCommand('cat f');
            lastBlock().output = output;
            await get(`/copy?id=${lastBlock().id}&type=output`);
            expect(d.clipboard.last).toBe(output);
          }
        ),
        { numRuns: 30 }
      );
    });

    it.each([
      ['/copy?type=cmd', 400],
      ['/copy?id=x', 400],
      ['/copy?id=x&type=html', 400],
      ['/copy?id=unknown&type=cmd', 404],
    ])('%s → %i and nothing copied', async (p, status) => {
      expect((await get(p)).status).toBe(status);
      expect(d.clipboard.writes).toEqual([]);
    });

    it('clipboard failure → 500, logged (Req 9.2)', async () => {
      await runCommand('ls');
      d.clipboard.fail = true;
      const res = await get(`/copy?id=${lastBlock().id}&type=cmd`);
      expect(res.status).toBe(500);
      expect(res.body).toContain('clipboard unavailable');
      expect(d.logs.some((l) => l.includes('Clipboard write failed'))).toBe(true);
    });
  });

  describe('/select and /copy-selected', () => {
    it('[+] collects blocks and puts the whole collection on the clipboard right away', async () => {
      await runCommand('first', { output: 'one' });
      const a = lastBlock().id;
      await runCommand('second', { output: 'two\n' });
      const b = lastBlock().id;

      expect((await get(`/select?id=${b}`)).body).toBe('Added to collection: 1 command copied');
      expect(d.clipboard.last).toBe('$ second\ntwo\n\n\n');
      // Clicking an older block still keeps chronological order
      expect((await get(`/select?id=${a}`)).body).toBe('Added to collection: 2 commands copied');
      expect(d.clipboard.last).toBe('$ first\none\n\n$ second\ntwo\n\n\n');
      // Toggling off rewrites the clipboard without it
      expect((await get(`/select?id=${b}`)).body).toBe('Removed from collection: 1 command left');
      expect(d.clipboard.last).toBe('$ first\none\n\n');
      // Removing the last one leaves the clipboard alone
      const writes = d.clipboard.writes.length;
      expect((await get(`/select?id=${a}`)).body).toBe('Removed from collection: 0 commands left');
      expect(d.clipboard.writes.length).toBe(writes);
    });

    it('[+] reports a clipboard failure', async () => {
      await runCommand('a');
      d.clipboard.fail = true;
      expect((await get(`/select?id=${lastBlock().id}`)).status).toBe(500);
    });

    it('/select validates its input', async () => {
      expect((await get('/select')).status).toBe(400);
      expect((await get('/select?id=nope')).status).toBe(404);
      expect(d.queue.size).toBe(0);
    });

    // Feature: clipcmd, Property 5: Multi-select batch copy format
    it('copies selected blocks in chronological order with the exact format (Property 5)', async () => {
      await runCommand('one', { output: 'out1\n' });
      await runCommand('two', { output: '' });
      await runCommand('three', { output: 'out3' });
      const [b1, , b3] = d.ringBuffer.getAll();
      await get(`/select?id=${b3.id}`); // selected newest first
      await get(`/select?id=${b1.id}`);

      const res = await get('/copy-selected');
      expect(res.status).toBe(200);
      expect(res.body).toBe('Copied 2 blocks to clipboard');
      expect(d.clipboard.last).toBe('$ one\nout1\n\n\n$ three\nout3\n\n');
      expect(d.queue.size).toBe(0);
    });

    it('empty queue copies an empty string with 200 (Req 6.5)', async () => {
      const res = await get('/copy-selected');
      expect(res.status).toBe(200);
      expect(d.clipboard.writes).toEqual(['']);
    });

    it('keeps the queue when the clipboard write fails', async () => {
      await runCommand('a');
      await get(`/select?id=${lastBlock().id}`);
      d.clipboard.fail = true;
      expect((await get('/copy-selected')).status).toBe(500);
      expect(d.queue.size).toBe(1);
    });

    // Feature: clipcmd, Property 10: Evicted Block removed from Multi_Select_Queue
    it('drops evicted blocks from the selection (Property 10)', async () => {
      await runCommand('oldest');
      const oldest = lastBlock().id;
      await get(`/select?id=${oldest}`);
      for (let i = 0; i < 5; i++) await runCommand(`cmd ${i}`); // capacity is 5
      expect(d.ringBuffer.get(oldest)).toBeUndefined();
      expect(d.queue.has(oldest)).toBe(false);
      expect((await get(`/copy?id=${oldest}&type=cmd`)).status).toBe(404);
    });
  });
});

describe('POST /output (output captured by clipcmd shell or the VS Code extension)', () => {
  let dir: string;
  let d: TestDaemon;
  const post = (p: string, body: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: d.port, path: p, method: 'POST', headers, agent: false }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end(body);
    });

  beforeEach(async () => {
    dir = makeTempDir();
    d = await startTestDaemon({ configDir: dir, maxOutputBytes: 10 });
  });
  afterEach(async () => {
    await d.stop();
    removeDir(dir);
  });

  it('attaches output by session and command counter, even before /end', async () => {
    await request(d.port, `/start?${qs({ cmd: 'ls', pwd: '/', sid: 's1', seq: '7' })}`);
    expect((await post('/output?sid=s1&seq=7', 'a.txt')).status).toBe(200); // before /end
    await request(d.port, '/end?exitCode=0&sid=s1');
    const block = d.ringBuffer.getAll()[0];
    expect(block).toMatchObject({ command: 'ls', output: 'a.txt', outputFromClient: true, seq: 7 });

    expect((await post('/output?sid=s1&seq=7', 'b.txt')).status).toBe(200); // after /end
    expect(d.ringBuffer.getAll()[0].output).toBe('b.txt');
    expect((await post('/output?sid=s1&seq=8', 'x')).status).toBe(404);
    expect((await post('/output?sid=other&seq=7', 'x')).status).toBe(404);
  });

  it('attaches output by command text for VS Code', async () => {
    await request(d.port, `/start?${qs({ cmd: 'npm test ', pwd: '/', sid: 'bash1', term: 'vscode' })}`);
    await request(d.port, '/end?exitCode=0&sid=bash1');
    // VS Code's terminal pid can differ from the hook's session (Git Bash launcher)
    expect((await post(`/output?${qs({ sid: '999', cmd: 'npm test' })}`, 'ok')).status).toBe(200);
    expect(d.ringBuffer.getAll()[0].output).toBe('ok');
    expect((await post(`/output?${qs({ cmd: 'something else' })}`, 'x')).status).toBe(404);
  });

  it('keeps only the last maxOutputBytes', async () => {
    await request(d.port, `/start?${qs({ cmd: 'ls', pwd: '/', sid: 's', seq: '1' })}`);
    await post('/output?sid=s&seq=1', '0123456789abcdef');
    await request(d.port, '/end?exitCode=0&sid=s');
    expect(d.ringBuffer.getAll()[0].output).toBe('6789abcdef');
  });

  it('validates its input and method', async () => {
    expect((await post('/output', 'x')).status).toBe(400);
    expect((await post('/output?seq=1', 'x')).status).toBe(400); // seq needs sid
    expect((await post('/output?sid=a&seq=abc', 'x')).status).toBe(400);
    expect((await post('/output?sid=../x&cmd=ls', 'x')).status).toBe(400);
    expect((await request(d.port, '/output?cmd=ls')).status).toBe(405);
    expect((await post('/copy?id=x&type=cmd', '')).status).toBe(405);
    expect((await post('/output?cmd=ls', 'x', { Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('/client only accepts the VS Code extension', async () => {
    expect((await request(d.port, '/client?kind=vscode')).body).toBe('{"status":"ok"}');
    expect((await request(d.port, '/client?kind=other')).status).toBe(400);
  });
});

describe('Windows Terminal buttons and the click tip', () => {
  let dir: string;
  let d: TestDaemon;
  const calls: Array<[string, string, string]> = [];
  const forgotten: string[] = [];
  let linkFor: ((button: string) => string | undefined) | undefined;
  let tip: string | undefined;

  beforeEach(async () => {
    dir = makeTempDir();
    calls.length = 0;
    forgotten.length = 0;
    linkFor = (button) => `file:///C:/links/${button}.lnk`;
    tip = undefined;
    d = await startTestDaemon({
      configDir: dir,
      ringBufferSize: 2,
      linkScheme: () => 'clipcmd',
      buttonLinks: {
        urlFor: (blockId, button, link) => {
          calls.push([blockId, button, link]);
          return linkFor?.(button);
        },
        forget: (blockId) => forgotten.push(blockId),
      },
      clickTip: () => tip,
    });
  });
  afterEach(async () => {
    await d.stop();
    removeDir(dir);
  });

  async function run(sid: string, term?: string): Promise<string> {
    await request(d.port, `/start?${qs({ cmd: `echo ${sid}`, pwd: '/', sid, ...(term ? { term } : {}) })}`);
    return (await request(d.port, `/end?exitCode=0&sid=${sid}`)).body;
  }

  it('links each Windows Terminal button to a shortcut for its clipcmd:// link', async () => {
    const body = await run('wt1', 'wt');
    const id = d.ringBuffer.getAll()[0].id;
    expect(calls).toEqual([
      [id, 'cmd', `${urlScheme()}://copy?id=${id}&type=cmd`],
      [id, 'select', `${urlScheme()}://select?id=${id}`],
    ]);
    expect(body).toContain('\x1b]8;;file:///C:/links/cmd.lnk\x07[COPY CMD]');
    expect(body).toContain('\x1b]8;;file:///C:/links/select.lnk\x07[+]');
    expect(body).not.toContain(`${urlScheme()}://`);
  });

  it('keeps clipcmd:// links elsewhere, and when no shortcut could be written', async () => {
    expect(await run('vs', 'vscode')).toContain(`${urlScheme()}://copy?id=`);
    expect(await run('plain')).toContain(`${urlScheme()}://copy?id=`);
    expect(calls).toEqual([]);
    linkFor = () => undefined;
    expect(await run('wt2', 'wt')).toContain(`${urlScheme()}://copy?id=`);
  });

  it('removes the shortcuts of commands that fall out of the history', async () => {
    await run('a', 'wt');
    const first = d.ringBuffer.getAll()[0].id;
    await run('b', 'wt');
    expect(forgotten).toEqual([]);
    await run('c', 'wt'); // capacity 2: the first block is evicted
    expect(forgotten).toEqual([first]);
  });

  it('adds the click tip to a session’s first buttons only', async () => {
    tip = 'clipcmd: hold Ctrl and click a button to copy.';
    expect(await run('s1', 'wt')).toContain(tip);
    expect(await run('s1', 'wt')).not.toContain(tip);
    expect(await run('s2', 'wt')).toContain(tip);
    tip = undefined;
    expect(await run('s3', 'wt')).not.toContain('hold Ctrl');
  });
});

describe('DaemonServer lifecycle', () => {
  let dir: string;
  const saved = process.env.CLIPCMD_CONFIG_DIR;

  beforeEach(() => {
    dir = makeTempDir();
    process.env.CLIPCMD_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
    removeDir(dir);
  });

  function makeServer(port: number, onShutdown?: () => void): DaemonServer {
    return new DaemonServer(
      new RingBuffer(10),
      new MultiSelectQueue(),
      new FileTailCapture({ sessionsDir: () => dir }),
      new FakeClipboard(),
      port,
      { onShutdown }
    );
  }

  it('writes {port}:{pid} after binding to 127.0.0.1 only, and removes it on stop', async () => {
    const server = makeServer(0);
    await server.start();
    expect(readPortFile()).toEqual({ port: server.getPort(), pid: process.pid });
    await expect(server.start()).rejects.toThrow(/already started/);
    await server.stop();
    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
    await server.stop(); // idempotent
  });

  it('does not delete a Port_File that now belongs to another daemon', async () => {
    const server = makeServer(0);
    await server.start();
    writePortFile(1234, process.pid + 1);
    await server.stop();
    expect(readPortFile()).toEqual({ port: 1234, pid: process.pid + 1 });
  });

  it('scans past busy ports (Req 1.2)', async () => {
    const probe = makeServer(0);
    await probe.start();
    const busy = probe.getPort();
    const second = makeServer(busy);
    try {
      await second.start();
      expect(second.getPort()).toBeGreaterThan(busy);
      expect(second.getPort()).toBeLessThanOrEqual(busy + 10);
    } finally {
      await second.stop();
      await probe.stop();
    }
  });

  it('fails clearly when every port in range is taken', async () => {
    const base = 47100 + Math.floor(Math.random() * 500);
    const held: net.Server[] = [];
    try {
      for (let p = base; p <= base + 10; p++) held.push(await occupyPort(p));
    } catch {
      held.forEach((s) => s.close());
      return; // environment already uses one of these ports; skip
    }
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      await expect(makeServer(base).start()).rejects.toThrow(`Failed to bind to any port in range ${base}–${base + 10}`);
      await new Promise((r) => setImmediate(r));
      // Regression: each failed attempt used to leak a 'listening' listener
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
      held.forEach((s) => s.close());
    }
  });

  it('/shutdown answers, closes the server and calls onShutdown', async () => {
    let shutdownCalled = false;
    const server = makeServer(0, () => (shutdownCalled = true));
    await server.start();
    const port = server.getPort();
    const res = await request(port, '/shutdown');
    expect(res.body).toBe('Shutting down');
    await new Promise((r) => setTimeout(r, 200));
    expect(shutdownCalled).toBe(true);
    await expect(request(port, '/health')).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
  });
});
