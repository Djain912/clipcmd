import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ClipCmdConfig, ConfigManager, DEFAULT_CONFIG, normalizeConfig } from '../config';
import { getConfigDir, getConfigFile, getLogFile, getPortFile, getSessionsDir } from '../paths';
import { makeTempDir, removeDir } from '../../../test/helpers';

describe('config paths', () => {
  const saved = process.env.CLIPCMD_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
  });

  it('defaults to ~/.config/clipcmd', () => {
    delete process.env.CLIPCMD_CONFIG_DIR;
    expect(getConfigDir()).toMatch(/[\\/]\.config[\\/]clipcmd$/);
  });

  it('honours CLIPCMD_CONFIG_DIR at call time, ignoring blank values', () => {
    process.env.CLIPCMD_CONFIG_DIR = path.join('some', 'dir');
    expect(getConfigDir()).toBe(path.resolve('some', 'dir'));
    expect(getPortFile()).toBe(path.resolve('some', 'dir', 'port'));
    expect(getConfigFile()).toBe(path.resolve('some', 'dir', 'config.json'));
    expect(getLogFile()).toBe(path.resolve('some', 'dir', 'daemon.log'));
    expect(getSessionsDir()).toBe(path.resolve('some', 'dir', 'sessions'));
    process.env.CLIPCMD_CONFIG_DIR = '   ';
    expect(getConfigDir()).toMatch(/[\\/]\.config[\\/]clipcmd$/);
  });
});

describe('ConfigManager', () => {
  let dir: string;
  const saved = process.env.CLIPCMD_CONFIG_DIR;

  beforeEach(() => {
    dir = makeTempDir();
    process.env.CLIPCMD_CONFIG_DIR = path.join(dir, 'nested', 'clipcmd');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
    removeDir(dir);
  });

  function writeRaw(content: string): void {
    fs.mkdirSync(path.dirname(getConfigFile()), { recursive: true });
    fs.writeFileSync(getConfigFile(), content);
  }

  it('returns defaults when the file is missing', () => {
    expect(ConfigManager.load()).toEqual(DEFAULT_CONFIG);
  });

  it.each(['{not json', '', '"a string"', '42', 'null', '[1,2]'])(
    'returns defaults without throwing for %j',
    (content) => {
      writeRaw(content);
      const warnings: string[] = [];
      expect(ConfigManager.load((w) => warnings.push(w))).toEqual(DEFAULT_CONFIG);
      expect(warnings.length).toBe(1);
    }
  );

  it('merges partial configs over the defaults', () => {
    writeRaw(JSON.stringify({ port: 12345 }));
    expect(ConfigManager.load()).toEqual({ ...DEFAULT_CONFIG, port: 12345 });
  });

  it('accepts a UTF-8 BOM', () => {
    writeRaw('﻿' + JSON.stringify({ ringBufferSize: 5 }));
    expect(ConfigManager.load().ringBufferSize).toBe(5);
  });

  it.each([
    ['port', 0],
    ['port', 70000],
    ['port', '9666'],
    ['port', 1.5],
    ['ringBufferSize', 0],
    ['ringBufferSize', -1],
    ['ringBufferSize', null],
    ['maxOutputBytes', -1],
    ['links', 'ftp'],
    ['links', true],
    ['autoShell', 'yes'],
    ['autoShell', 0],
    ['copyFeedback', 'off'],
  ])('replaces invalid %s=%j with the default and warns', (key, value) => {
    writeRaw(JSON.stringify({ [key]: value }));
    const warnings: string[] = [];
    const config = ConfigManager.load((w) => warnings.push(w));
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings[0]).toContain(key);
  });

  it('accepts the links, autoShell and copyFeedback settings', () => {
    writeRaw(JSON.stringify({ links: 'http', autoShell: false, copyFeedback: false }));
    expect(ConfigManager.load()).toEqual({ ...DEFAULT_CONFIG, links: 'http', autoShell: false, copyFeedback: false });
  });

  it('ignores unknown keys', () => {
    writeRaw(JSON.stringify({ theme: 'dark', port: 2000 }));
    expect(ConfigManager.load()).toEqual({ ...DEFAULT_CONFIG, port: 2000 });
  });

  it('save() creates missing directories', () => {
    const config: ClipCmdConfig = { port: 3000, ringBufferSize: 10, maxOutputBytes: 5, links: 'http', autoShell: false };
    ConfigManager.save(config);
    expect(JSON.parse(fs.readFileSync(getConfigFile(), 'utf8'))).toEqual(config);
  });

  it('round-trips any valid config', () => {
    fc.assert(
      fc.property(
        fc.record({
          port: fc.integer({ min: 1024, max: 65535 }),
          ringBufferSize: fc.integer({ min: 1, max: 1000 }),
          maxOutputBytes: fc.integer({ min: 0, max: 1024 * 1024 }),
          links: fc.constantFrom('auto' as const, 'clipcmd' as const, 'http' as const),
          autoShell: fc.boolean(),
          copyFeedback: fc.boolean(),
        }),
        (config: ClipCmdConfig) => {
          ConfigManager.save(config);
          expect(ConfigManager.load()).toEqual(config);
          expect(normalizeConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
        }
      ),
      { numRuns: 50 }
    );
  });
});
