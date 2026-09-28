import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isProcessAlive,
  parsePortFile,
  readPortFile,
  removePortFileIfOwned,
  writePortFile,
} from '../portFile';
import { makeTempDir, removeDir } from '../../../test/helpers';

describe('parsePortFile', () => {
  it.each([
    ['9666:1234', { port: 9666, pid: 1234 }],
    ['9666', { port: 9666, pid: undefined }],
    ['  9666:1234\r\n', { port: 9666, pid: 1234 }],
    ['﻿9666:42', { port: 9666, pid: 42 }],
    ['1:1', { port: 1, pid: 1 }],
    ['65535:0', { port: 65535, pid: undefined }],
  ])('parses %j', (content, expected) => {
    expect(parsePortFile(content)).toEqual(expected);
  });

  it.each(['', 'abc', '0:12', '65536:1', '70000', '-1:5', '9666:', ':1234', '9666:12:3', '9666:abc', '96 66', '9666.5'])(
    'rejects %j',
    (content) => {
      expect(parsePortFile(content)).toBeUndefined();
    }
  );
});

describe('port file I/O', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = makeTempDir();
    file = path.join(dir, 'sub', 'port');
  });
  afterEach(() => removeDir(dir));

  it('writes {port}:{pid}, creating the directory, and leaves no temp file', () => {
    writePortFile(4000, 77, file);
    expect(fs.readFileSync(file, 'utf8')).toBe('4000:77');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['port']);
    writePortFile(4001, 78, file);
    expect(readPortFile(file)).toEqual({ port: 4001, pid: 78 });
  });

  it('readPortFile never throws (missing file, directory in its place)', () => {
    expect(readPortFile(file)).toBeUndefined();
    fs.mkdirSync(file, { recursive: true });
    expect(readPortFile(file)).toBeUndefined();
  });

  it('only removes the file when it belongs to the given pid (or has no pid)', () => {
    writePortFile(4000, 77, file);
    removePortFileIfOwned(99, file);
    expect(fs.existsSync(file)).toBe(true);
    removePortFileIfOwned(77, file);
    expect(fs.existsSync(file)).toBe(false);

    fs.writeFileSync(file, '4000');
    removePortFileIfOwned(99, file);
    expect(fs.existsSync(file)).toBe(false);

    removePortFileIfOwned(99, file); // already gone: no throw
  });
});

describe('isProcessAlive', () => {
  it('detects the current process and an exited one', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(isProcessAlive(child.pid as number)).toBe(false);
  });
});
