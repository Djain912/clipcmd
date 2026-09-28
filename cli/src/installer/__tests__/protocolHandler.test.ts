import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appleScriptSource,
  cliEntry,
  desktopEntry,
  isProtocolHandlerInstalled,
  linuxDesktopFile,
  macAppPath,
  parseButtonUrl,
  registerProtocolHandler,
  unregisterProtocolHandler,
  urlScheme,
} from '../protocolHandler';
import { request, startTestDaemon, waitFor } from '../../../test/helpers';

describe('parseButtonUrl', () => {
  it.each([
    ['clipcmd://copy?id=ab-12&type=cmd', { action: 'copy', query: 'id=ab-12&type=cmd' }],
    ['clipcmd://copy/?id=ab-12&type=both', { action: 'copy', query: 'id=ab-12&type=both' }], // Windows normalization
    ['clipcmd:copy?id=1', { action: 'copy', query: 'id=1' }],
    ['CLIPCMD://SELECT?id=1', { action: 'select', query: 'id=1' }],
    ['clipcmd://copy-selected', { action: 'copy-selected', query: '' }],
    ['  clipcmd://select?id=1  ', { action: 'select', query: 'id=1' }],
  ])('accepts %j', (url, expected) => {
    expect(parseButtonUrl(url)).toEqual(expected);
  });

  it.each([
    '',
    'clipcmd://',
    'clipcmd://shutdown',
    'clipcmd://health',
    'clipcmd://copy?id=1#frag',
    'clipcmd://copy?id=1&x=<script>',
    'clipcmd://copy?id=1 2',
    'clipcmd://copy/../shutdown',
    'clipcmd://copy?id=1\nx=2',
    '://copy?id=1',
  ])('rejects %j', (url) => {
    expect(parseButtonUrl(url)).toBeUndefined();
  });
});

describe('urlScheme', () => {
  const saved = process.env.CLIPCMD_URL_SCHEME;
  afterEach(() => {
    process.env.CLIPCMD_URL_SCHEME = saved;
  });

  it('honors a valid override and ignores an invalid one', () => {
    process.env.CLIPCMD_URL_SCHEME = 'my-scheme';
    expect(urlScheme()).toBe('my-scheme');
    for (const bad of ['', 'Has Space', '1abc', 'a/b', 'x'.repeat(40)]) {
      process.env.CLIPCMD_URL_SCHEME = bad;
      expect(urlScheme()).toBe('clipcmd');
    }
  });
});

describe('Linux .desktop entry', () => {
  it('runs `clipcmd open %u` with node and the CLI given as absolute, quoted paths', () => {
    const entry = desktopEntry('clipcmd');
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('MimeType=x-scheme-handler/clipcmd;');
    expect(entry).toContain('NoDisplay=true');
    const exec = /^Exec=(.*)$/m.exec(entry)![1];
    expect(exec.endsWith(' open %u')).toBe(true);
    expect(exec.startsWith('"')).toBe(true);
    expect(cliEntry().endsWith(path.join('bin', 'clipcmd.js'))).toBe(true);
  });

  it('lives under XDG_DATA_HOME', () => {
    expect(linuxDesktopFile('clipcmd')).toBe(path.join(process.env.XDG_DATA_HOME!, 'applications', 'clipcmd-url-handler.desktop'));
  });
});

describe('macOS AppleScript handler', () => {
  it('passes the URL to `clipcmd open` as a quoted argument', () => {
    const source = appleScriptSource();
    expect(source).toContain('on open location theURL');
    expect(source).toContain('" open " & (quoted form of theURL)');
    // AppleScript string literal: backslashes doubled
    expect(source).toContain(`quoted form of "${process.execPath.replace(/\\/g, '\\\\')}"`);
  });
});

const hasXdgMime = process.platform === 'linux' && spawnSync('xdg-mime', ['--version']).status === 0;

describe.skipIf(!hasXdgMime)('Linux registration (xdg-mime)', () => {
  let configHome: string;
  const saved = process.env.XDG_CONFIG_HOME;
  beforeEach(() => {
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcmd-xdg-config-'));
    process.env.XDG_CONFIG_HOME = configHome;
  });
  afterEach(() => {
    unregisterProtocolHandler();
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(configHome, { recursive: true, force: true });
  });

  it('registers the throwaway scheme as the default handler and removes it again', () => {
    expect(registerProtocolHandler()).toBeUndefined();
    expect(isProtocolHandlerInstalled()).toBe(true);
    const query = spawnSync('xdg-mime', ['query', 'default', `x-scheme-handler/${urlScheme()}`], {
      encoding: 'utf8',
      env: process.env,
    });
    expect(query.stdout.trim()).toBe(path.basename(linuxDesktopFile()));

    unregisterProtocolHandler();
    expect(isProtocolHandlerInstalled()).toBe(false);
    const mimeapps = path.join(configHome, 'mimeapps.list');
    if (fs.existsSync(mimeapps)) expect(fs.readFileSync(mimeapps, 'utf8')).not.toContain(urlScheme());
  });

  it('a click (xdg-open) reaches the daemon through `clipcmd open`', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcmd-xdg-daemon-'));
    const savedConfigDir = process.env.CLIPCMD_CONFIG_DIR;
    process.env.CLIPCMD_CONFIG_DIR = configDir; // inherited by xdg-open and the handler
    const daemon = await startTestDaemon({ configDir, writePortFile: true });
    try {
      expect(registerProtocolHandler()).toBeUndefined();
      await request(daemon.port, '/start?cmd=echo%20linux&pwd=%2F&sid=x');
      const { body } = await request(daemon.port, '/end?exitCode=0&sid=x');
      const id = /[?&]id=([0-9a-f-]+)/.exec(body)![1];
      spawnSync('xdg-open', [`${urlScheme()}://copy?id=${id}&type=cmd`], { env: process.env, timeout: 20000 });
      await waitFor(() => daemon.clipboard.last === 'echo linux', 15000);
    } finally {
      await daemon.stop();
      process.env.CLIPCMD_CONFIG_DIR = savedConfigDir;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'darwin')('macOS registration (LaunchServices)', () => {
  afterEach(() => unregisterProtocolHandler());

  it('builds a background app that declares the throwaway scheme, and removes it again', () => {
    expect(registerProtocolHandler()).toBeUndefined();
    expect(isProtocolHandlerInstalled()).toBe(true);
    const plist = spawnSync('plutil', ['-p', path.join(macAppPath(), 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout;
    expect(plist).toContain(`"${urlScheme()}"`);
    expect(plist).toMatch(/"LSUIElement" => (true|1)/);
    unregisterProtocolHandler();
    expect(isProtocolHandlerInstalled()).toBe(false);
  }, 60000);
});
