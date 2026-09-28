import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyHookBlock,
  getConfigPath,
  getHookFilePath,
  HOOK_END_MARKER,
  HOOK_START_MARKER,
  install,
  isInstalled,
  MalformedHookBlockError,
  removeHookBlock,
  uninstall,
} from '../installer';
import { makeTempDir, removeDir } from '../../../test/helpers';

const HOOK = '# hook body\necho hi\n';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Arbitrary shell-config-like text that never contains our markers. */
const configText = fc
  .array(fc.oneof(fc.string(), fc.constantFrom('export PATH=$PATH:~/bin', 'alias ll="ls -l"', '# comment', '')), {
    maxLength: 20,
  })
  .map((lines) => lines.join('\n'))
  .filter((text) => !text.includes('CLIPCMD HOOK'));

describe('applyHookBlock / removeHookBlock (pure)', () => {
  it('appends to an empty file with markers and a trailing newline', () => {
    expect(applyHookBlock('', HOOK)).toBe(`${HOOK_START_MARKER}\n# hook body\necho hi\n${HOOK_END_MARKER}\n`);
  });

  it('adds a separating newline when the file does not end with one', () => {
    expect(applyHookBlock('alias x=y', HOOK).startsWith('alias x=y\n# === CLIPCMD')).toBe(true);
  });

  it('normalizes CRLF hook content to LF', () => {
    const result = applyHookBlock('', 'echo a\r\necho b\r\n');
    expect(result).not.toContain('\r');
  });

  it('replaces an outdated block in place, keeping surrounding content', () => {
    const old = `before\n${HOOK_START_MARKER}\nold hook\n${HOOK_END_MARKER}\nafter\n`;
    expect(applyHookBlock(old, HOOK)).toBe(`before\n${HOOK_START_MARKER}\n# hook body\necho hi\n${HOOK_END_MARKER}\nafter\n`);
  });

  it('collapses duplicate blocks into one', () => {
    const block = `${HOOK_START_MARKER}\nx\n${HOOK_END_MARKER}\n`;
    const result = applyHookBlock(`a\n${block}b\n${block}c\n`, HOOK);
    expect(countOccurrences(result, HOOK_START_MARKER)).toBe(1);
    expect(result).toMatch(/^a\n# === CLIPCMD HOOK START ===[\s\S]*END ===\nb\nc\n$/);
  });

  it('removes CRLF-terminated blocks cleanly', () => {
    const content = `a\r\n${HOOK_START_MARKER}\r\nx\r\n${HOOK_END_MARKER}\r\nb\r\n`;
    expect(removeHookBlock(content)).toBe('a\r\nb\r\n');
  });

  it('refuses to touch a START marker without END (would otherwise delete user content)', () => {
    const content = `a\n${HOOK_START_MARKER}\nimportant user config\n`;
    expect(() => applyHookBlock(content, HOOK)).toThrow(MalformedHookBlockError);
    expect(() => removeHookBlock(content)).toThrow(MalformedHookBlockError);
  });

  // Feature: clipcmd, Property 7: Hook idempotent installation
  it('installing twice equals installing once, with exactly one block (Property 7)', () => {
    fc.assert(
      fc.property(configText, (content) => {
        const once = applyHookBlock(content, HOOK);
        const twice = applyHookBlock(once, HOOK);
        expect(twice).toBe(once);
        expect(countOccurrences(twice, HOOK_START_MARKER)).toBe(1);
        expect(countOccurrences(twice, HOOK_END_MARKER)).toBe(1);
      })
    );
  });

  // Feature: clipcmd, Property 8: Hook clean uninstall
  it('uninstall removes both markers and preserves everything else (Property 8)', () => {
    fc.assert(
      fc.property(configText, configText, (before, after) => {
        const prefix = before === '' || before.endsWith('\n') ? before : `${before}\n`;
        const withHook = `${prefix}${HOOK_START_MARKER}\nanything\n${HOOK_END_MARKER}\n${after}`;
        const result = removeHookBlock(withHook);
        expect(result).not.toContain(HOOK_START_MARKER);
        expect(result).not.toContain(HOOK_END_MARKER);
        expect(result).toBe(prefix + after);
      })
    );
  });

  it('uninstall(install(x)) restores x for newline-terminated files', () => {
    fc.assert(
      fc.property(configText, (content) => {
        const normalized = content === '' || content.endsWith('\n') ? content : `${content}\n`;
        expect(removeHookBlock(applyHookBlock(normalized, HOOK))).toBe(normalized);
      })
    );
  });
});

describe('install / uninstall on disk', () => {
  let home: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = makeTempDir();
    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    removeDir(home);
  });

  it.each([
    ['zsh', '.zshrc'],
    ['bash', '.bashrc'],
    ['fish', path.join('.config', 'fish', 'config.fish')],
  ] as const)('installs the real %s hook into %s', (shell, rel) => {
    expect(getConfigPath(shell)).toBe(path.join(home, rel));
    expect(isInstalled(shell)).toBe(false);

    expect(install(shell)).toBe('installed');
    const content = fs.readFileSync(path.join(home, rel), 'utf8');
    expect(content).toContain(HOOK_START_MARKER);
    expect(content).toContain(fs.readFileSync(getHookFilePath(shell), 'utf8').trimEnd());
    expect(isInstalled(shell)).toBe(true);

    expect(install(shell)).toBe('unchanged');
    expect(uninstall(shell)).toBe(true);
    expect(fs.readFileSync(path.join(home, rel), 'utf8')).toBe('');
    expect(uninstall(shell)).toBe(false);
  });

  it('preserves existing config and reports an update when the hook changed', () => {
    const rc = path.join(home, '.bashrc');
    fs.writeFileSync(rc, `export A=1\n${HOOK_START_MARKER}\nold\n${HOOK_END_MARKER}\nexport B=2\n`);
    expect(install('bash')).toBe('updated');
    const content = fs.readFileSync(rc, 'utf8');
    expect(content.startsWith('export A=1\n')).toBe(true);
    expect(content.endsWith(`${HOOK_END_MARKER}\nexport B=2\n`)).toBe(true);
    expect(content).not.toContain('\nold\n');
  });

  it('uninstall on a missing config file is a no-op', () => {
    expect(uninstall('zsh')).toBe(false);
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false);
  });

  it('leaves a malformed file untouched', () => {
    const rc = path.join(home, '.bashrc');
    const content = `a\n${HOOK_START_MARKER}\nuser stuff\n`;
    fs.writeFileSync(rc, content);
    expect(() => install('bash')).toThrow(MalformedHookBlockError);
    expect(() => uninstall('bash')).toThrow(MalformedHookBlockError);
    expect(fs.readFileSync(rc, 'utf8')).toBe(content);
  });

  it('shipped hook files are LF-terminated pure ASCII (PowerShell 5.1 reads BOM-less files as ANSI)', () => {
    for (const shell of ['zsh', 'bash', 'fish', 'powershell', 'pwsh'] as const) {
      const bytes = fs.readFileSync(getHookFilePath(shell));
      expect(bytes.includes(0x0d)).toBe(false);
      expect([...bytes].every((b) => b < 0x80)).toBe(true);
    }
    expect(getHookFilePath('pwsh')).toBe(getHookFilePath('powershell'));
    expect(path.basename(getHookFilePath('powershell'))).toBe('powershell.ps1');
  });

  describe('PowerShell profiles', () => {
    let profile: string;
    const savedProfile = process.env.CLIPCMD_POWERSHELL_PROFILE;

    beforeEach(() => {
      profile = path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      process.env.CLIPCMD_POWERSHELL_PROFILE = profile;
    });
    afterEach(() => {
      if (savedProfile === undefined) delete process.env.CLIPCMD_POWERSHELL_PROFILE;
      else process.env.CLIPCMD_POWERSHELL_PROFILE = savedProfile;
    });

    it('creates the profile (and its folder) with the hook', () => {
      expect(getConfigPath('powershell')).toBe(profile);
      expect(install('powershell')).toBe('installed');
      const content = fs.readFileSync(profile, 'utf8');
      expect(content.startsWith(HOOK_START_MARKER)).toBe(true);
      expect(content).toContain('PSConsoleHostReadLine');
      expect(install('powershell')).toBe('unchanged');
      expect(uninstall('powershell')).toBe(true);
      expect(fs.readFileSync(profile, 'utf8')).toBe('');
    });

    it('moves the block after later prompt customizations (it wraps prompt)', () => {
      fs.mkdirSync(path.dirname(profile), { recursive: true });
      fs.writeFileSync(profile, `Set-Alias ll ls\n${HOOK_START_MARKER}\nold\n${HOOK_END_MARKER}\noh-my-posh init pwsh | Invoke-Expression\n`);
      expect(install('powershell')).toBe('updated');
      const content = fs.readFileSync(profile, 'utf8');
      expect(content.startsWith('Set-Alias ll ls\noh-my-posh init pwsh | Invoke-Expression\n# === CLIPCMD HOOK START ===')).toBe(true);
      expect(content.endsWith(`${HOOK_END_MARKER}\n`)).toBe(true);
    });
  });

  describe('keeps the config file encoding byte-for-byte', () => {
    const rc = () => path.join(home, '.bashrc');
    const user = 'Set-Alias grüße Get-Date # 日本 €\n';

    it.each([
      ['UTF-16LE with BOM (Windows PowerShell `>`)', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(user, 'utf16le')])],
      ['UTF-16BE with BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(user, 'utf16le').swap16()])],
      ['UTF-8 with BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(user, 'utf8')])],
      ['UTF-8', Buffer.from(user, 'utf8')],
      ['Windows-1252 (not valid UTF-8)', Buffer.from([0x23, 0x20, 0x67, 0x72, 0xfc, 0xdf, 0x65, 0x0a])],
    ])('%s', (_name, original) => {
      fs.writeFileSync(rc(), original);
      install('bash');
      // The block is appended, so the user's bytes must be an exact prefix
      const installed = fs.readFileSync(rc());
      expect(installed.subarray(0, original.length)).toEqual(original);
      expect(installed.length).toBeGreaterThan(original.length);
      expect(isInstalled('bash')).toBe(true);
      uninstall('bash');
      expect(fs.readFileSync(rc())).toEqual(original);
    });

    it('UTF-16 files stay UTF-16 (the hook is not appended as 8-bit text)', () => {
      fs.writeFileSync(rc(), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('echo hi\n', 'utf16le')]));
      install('bash');
      const buf = fs.readFileSync(rc());
      expect([buf[0], buf[1]]).toEqual([0xff, 0xfe]);
      expect(buf.subarray(2).toString('utf16le')).toContain(`echo hi\n${HOOK_START_MARKER}\n`);
    });
  });
});
