import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTailCapture, isValidSessionId } from '../capture';
import { makeTempDir, removeDir } from '../../../test/helpers';

describe('isValidSessionId', () => {
  it.each(['1234', 'abc-DEF_1.2', '0f8fad5b-d9cb-469f-a165-70867728950e', 'a'.repeat(64)])('accepts %s', (id) => {
    expect(isValidSessionId(id)).toBe(true);
  });
  it.each(['', '.', '..', '../etc', 'a/b', 'a\\b', 'a b', 'a'.repeat(65), 'é', 'x\0'])('rejects %j', (id) => {
    expect(isValidSessionId(id)).toBe(false);
  });
});

describe('FileTailCapture', () => {
  let dir: string;
  let capture: FileTailCapture;
  const file = (sid: string) => path.join(dir, `${sid}.log`);

  beforeEach(() => {
    dir = makeTempDir();
    capture = new FileTailCapture({ sessionsDir: () => dir, settleMs: 5, maxWaitMs: 50 });
  });
  afterEach(() => removeDir(dir));

  it('returns only bytes appended between start and end', async () => {
    fs.writeFileSync(file('s1'), 'before\n');
    capture.startCapture('b1', 's1');
    fs.appendFileSync(file('s1'), 'during\n');
    expect(await capture.endCapture('b1')).toBe('during\n');
  });

  it('returns empty output when the capture file is missing or unchanged', async () => {
    capture.startCapture('b1', 'none');
    expect(await capture.endCapture('b1')).toBe('');
    fs.writeFileSync(file('s1'), 'x');
    capture.startCapture('b2', 's1');
    expect(await capture.endCapture('b2')).toBe('');
  });

  it('returns empty output for unknown blocks and for a block ended twice', async () => {
    expect(await capture.endCapture('never-started')).toBe('');
    fs.writeFileSync(file('s1'), '');
    capture.startCapture('b1', 's1');
    fs.appendFileSync(file('s1'), 'x');
    expect(await capture.endCapture('b1')).toBe('x');
    expect(await capture.endCapture('b1')).toBe('');
  });

  it('captures from the start when the file did not exist at startCapture', async () => {
    capture.startCapture('b1', 's1');
    fs.writeFileSync(file('s1'), 'new file\n');
    expect(await capture.endCapture('b1')).toBe('new file\n');
  });

  it('keeps sessions separate', async () => {
    capture.startCapture('a', 'A');
    capture.startCapture('b', 'B');
    fs.appendFileSync(file('A'), 'from A');
    fs.appendFileSync(file('B'), 'from B');
    expect(await capture.endCapture('b')).toBe('from B');
    expect(await capture.endCapture('a')).toBe('from A');
  });

  it('preserves ANSI codes, tabs, CR/LF and UTF-8 exactly', async () => {
    const raw = '\x1b[31mred\x1b[0m\tTab\r\nline2\n  spaces  \nünïcødé 🚀\n';
    fs.writeFileSync(file('s'), '');
    capture.startCapture('b', 's');
    fs.appendFileSync(file('s'), raw, 'utf8');
    expect(await capture.endCapture('b')).toBe(raw);
  });

  it('reads the whole file when it was truncated mid-command', async () => {
    fs.writeFileSync(file('s'), 'x'.repeat(100));
    capture.startCapture('b', 's');
    fs.writeFileSync(file('s'), 'after truncate');
    expect(await capture.endCapture('b')).toBe('after truncate');
  });

  it('keeps only the last maxBytes, without splitting a UTF-8 character', async () => {
    capture = new FileTailCapture({ sessionsDir: () => dir, maxBytes: 5, settleMs: 5, maxWaitMs: 50 });
    fs.writeFileSync(file('s'), '');
    capture.startCapture('b', 's');
    fs.appendFileSync(file('s'), 'abcdefgh');
    expect(await capture.endCapture('b')).toBe('defgh');

    capture.startCapture('c', 's');
    // 'é' is 2 bytes; the 5-byte window starts in the middle of the first one
    fs.appendFileSync(file('s'), 'xxéééé'.normalize('NFC'));
    const out = await capture.endCapture('c');
    expect(out).not.toContain('�');
    expect(out.endsWith('éé')).toBe(true);
  });

  it('maxBytes 0 disables capture', async () => {
    capture = new FileTailCapture({ sessionsDir: () => dir, maxBytes: 0, settleMs: 5, maxWaitMs: 50 });
    fs.writeFileSync(file('s'), '');
    capture.startCapture('b', 's');
    fs.appendFileSync(file('s'), 'data');
    expect(await capture.endCapture('b')).toBe('');
  });

  it('waits for trailing output that lands just after the command finished', async () => {
    capture = new FileTailCapture({ sessionsDir: () => dir, settleMs: 40, maxWaitMs: 400 });
    fs.writeFileSync(file('s'), '');
    capture.startCapture('b', 's');
    fs.appendFileSync(file('s'), 'first ');
    setTimeout(() => fs.appendFileSync(file('s'), 'late'), 10);
    expect(await capture.endCapture('b')).toBe('first late');
  });

  it('rejects path-traversal session ids', () => {
    expect(() => capture.startCapture('b', '../../evil')).toThrow(/Invalid session id/);
  });
});
