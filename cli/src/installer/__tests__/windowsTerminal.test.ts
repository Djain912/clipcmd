import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowSchemeInWindowsTerminal,
  disallowSchemeInWindowsTerminal,
  findWindowsTerminalSettings,
  parseJsonc,
  withoutSafeUriScheme,
  withSafeUriScheme,
} from '../windowsTerminal';
import { makeTempDir, removeDir } from '../../../test/helpers';

/** Shape of a real Windows Terminal settings.json (comments included). */
const SETTINGS = `{
    "$help": "https://aka.ms/terminal-documentation",
    "$schema": "https://aka.ms/terminal-profiles-schema",
    // Default profile: Windows PowerShell
    "defaultProfile": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
    "profiles": {
        "list": [
            { "name": "Windows PowerShell", "commandline": "%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" },
        ]
    },
    /* block comment with "quotes" and { braces } */
    "schemes": []
}
`;

describe('parseJsonc', () => {
  it('accepts comments and trailing commas, but not inside strings', () => {
    expect(parseJsonc(SETTINGS)).toMatchObject({ defaultProfile: '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}' });
    expect(parseJsonc('{"url": "http://x//y", "a": "/* not a comment */"}')).toEqual({
      url: 'http://x//y',
      a: '/* not a comment */',
    });
    expect(() => parseJsonc('{ broken')).toThrow();
  });
});

describe('withSafeUriScheme', () => {
  it('adds the setting at the top of a real settings file, keeping comments and layout', () => {
    const edited = withSafeUriScheme(SETTINGS, 'clipcmd')!;
    expect(edited).toContain('{\n    "safeUriSchemes": ["clipcmd"],\n    "$help"');
    expect(edited).toContain('// Default profile: Windows PowerShell');
    expect(edited).toContain('/* block comment with "quotes" and { braces } */');
    expect((parseJsonc(edited) as { safeUriSchemes: string[] }).safeUriSchemes).toEqual(['clipcmd']);
  });

  it('appends to an existing list and is idempotent', () => {
    const text = '{\n  "safeUriSchemes": ["vscode"],\n  "x": 1\n}';
    const once = withSafeUriScheme(text, 'clipcmd')!;
    expect((parseJsonc(once) as { safeUriSchemes: string[] }).safeUriSchemes).toEqual(['vscode', 'clipcmd']);
    expect(withSafeUriScheme(once, 'clipcmd')).toBe(once);
    expect(withSafeUriScheme('{"safeUriSchemes": []}', 'clipcmd')).toBe('{"safeUriSchemes": ["clipcmd"]}');
  });

  it('handles an empty object', () => {
    expect((parseJsonc(withSafeUriScheme('{}', 'clipcmd')!) as object)).toEqual({ safeUriSchemes: ['clipcmd'] });
  });

  it.each(['not json', '[1,2]', '{"safeUriSchemes": "vscode"}'])('refuses to edit %j', (text) => {
    expect(withSafeUriScheme(text, 'clipcmd')).toBeUndefined();
  });
});

describe('withoutSafeUriScheme', () => {
  it.each([
    ['{"safeUriSchemes": ["vscode", "clipcmd"]}', ['vscode']],
    ['{"safeUriSchemes": ["clipcmd", "vscode"]}', ['vscode']],
    ['{"safeUriSchemes": ["a", "clipcmd", "b"]}', ['a', 'b']],
  ])('removes it from %s', (text, expected) => {
    expect((parseJsonc(withoutSafeUriScheme(text, 'clipcmd')!) as { safeUriSchemes: string[] }).safeUriSchemes).toEqual(expected);
  });

  it('does nothing when absent', () => {
    expect(withoutSafeUriScheme('{"safeUriSchemes": ["vscode"]}', 'clipcmd')).toBeUndefined();
    expect(withoutSafeUriScheme('{}', 'clipcmd')).toBeUndefined();
  });

  it('drops the key when it was the only scheme, restoring the file exactly', () => {
    expect(withoutSafeUriScheme(withSafeUriScheme(SETTINGS, 'clipcmd')!, 'clipcmd')).toBe(SETTINGS);
    expect(withoutSafeUriScheme('{\n  "a": 1,\n  "safeUriSchemes": ["clipcmd"]\n}', 'clipcmd')).toBe('{\n  "a": 1\n}');
    expect(parseJsonc(withoutSafeUriScheme('{"safeUriSchemes": ["clipcmd"]}', 'clipcmd')!)).toEqual({});
  });
});

describe('Windows Terminal settings files', () => {
  let dir: string;
  let settings: string;
  const saved = process.env.CLIPCMD_CONFIG_DIR;

  beforeEach(() => {
    dir = makeTempDir();
    process.env.CLIPCMD_CONFIG_DIR = path.join(dir, 'clipcmd');
    settings = path.join(dir, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLIPCMD_CONFIG_DIR;
    else process.env.CLIPCMD_CONFIG_DIR = saved;
    removeDir(dir);
  });

  it('finds installed flavours only', () => {
    expect(findWindowsTerminalSettings(dir)).toEqual([]);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, SETTINGS);
    expect(findWindowsTerminalSettings(dir)).toEqual([settings]);
    expect(findWindowsTerminalSettings('')).toEqual([]);
  });

  it('adds the scheme with a backup, reports it, and undoes it', () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, SETTINGS);

    expect(allowSchemeInWindowsTerminal('clipcmd', [settings])).toEqual([{ file: settings, status: 'added' }]);
    expect((parseJsonc(fs.readFileSync(settings, 'utf8')) as { safeUriSchemes: string[] }).safeUriSchemes).toEqual(['clipcmd']);
    const backups = fs.readdirSync(path.join(dir, 'clipcmd', 'backups'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'clipcmd', 'backups', backups[0]), 'utf8')).toBe(SETTINGS);

    expect(allowSchemeInWindowsTerminal('clipcmd', [settings])).toEqual([{ file: settings, status: 'present' }]);

    disallowSchemeInWindowsTerminal('clipcmd', [settings]);
    expect(fs.readFileSync(settings, "utf8")).toBe(SETTINGS);
  });

  it('leaves an unparsable file untouched', () => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ "oops": ');
    expect(allowSchemeInWindowsTerminal('clipcmd', [settings])).toEqual([{ file: settings, status: 'failed' }]);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ "oops": ');
  });
});
