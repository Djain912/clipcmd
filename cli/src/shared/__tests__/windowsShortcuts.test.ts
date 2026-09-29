import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { makeTempDir, removeDir } from '../../../test/helpers';
import {
  ButtonShortcuts,
  createShortcutTemplate,
  fileUrl,
  getShortcutArguments,
  getShortcutTemplatePath,
  handlerArguments,
  setShortcutArguments,
} from '../windowsShortcuts';

/** A minimal Unicode shell link: header + optional strings + an empty ExtraData terminator. */
function makeLink(strings: { name?: string; relPath?: string; workDir?: string; args?: string; icon?: string }): Buffer {
  const flagsFor = [
    [0x04, strings.name],
    [0x08, strings.relPath],
    [0x10, strings.workDir],
    [0x20, strings.args],
    [0x40, strings.icon],
  ] as const;
  let flags = 0x80; // IsUnicode
  const parts: Buffer[] = [];
  for (const [flag, value] of flagsFor) {
    if (value === undefined) continue;
    flags |= flag;
    const b = Buffer.alloc(2 + value.length * 2);
    b.writeUInt16LE(value.length, 0);
    b.write(value, 2, 'utf16le');
    parts.push(b);
  }
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  header.writeUInt32LE(flags, 0x14);
  return Buffer.concat([header, ...parts, Buffer.alloc(4)]);
}

function readString(link: Buffer, flag: number): string | undefined {
  const flags = link.readUInt32LE(0x14);
  let offset = 0x4c;
  for (const f of [0x04, 0x08, 0x10, 0x20, 0x40]) {
    if (!(flags & f)) continue;
    const count = link.readUInt16LE(offset);
    if (f === flag) return link.subarray(offset + 2, offset + 2 + count * 2).toString('utf16le');
    offset += 2 + count * 2;
  }
  return undefined;
}

describe('setShortcutArguments', () => {
  it('adds arguments to a link that has none, keeping the other strings in order', () => {
    const link = setShortcutArguments(makeLink({ relPath: '.\\wscript.exe', workDir: 'C:\\', icon: 'x.ico' }), '//B "a b"');
    expect(getShortcutArguments(link)).toBe('//B "a b"');
    expect(readString(link, 0x08)).toBe('.\\wscript.exe');
    expect(readString(link, 0x10)).toBe('C:\\');
    expect(readString(link, 0x40)).toBe('x.ico');
    expect(link.subarray(-4)).toEqual(Buffer.alloc(4)); // ExtraData kept
  });

  it('replaces existing arguments of any length (round trip)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 300 }), (before, after) => {
        const link = setShortcutArguments(makeLink({ name: 'n', args: before, icon: 'i' }), after);
        expect(getShortcutArguments(link)).toBe(after);
        expect(readString(link, 0x04)).toBe('n');
        expect(readString(link, 0x40)).toBe('i');
      })
    );
  });

  it('skips the target ID list and link info blocks', () => {
    const base = makeLink({ args: 'old' });
    const idList = Buffer.from([4, 0, 2, 0, 0, 0]); // size 4 + (one 2-byte terminator + 2 bytes)
    const linkInfo = Buffer.alloc(8);
    linkInfo.writeUInt32LE(8, 0);
    const header = Buffer.from(base.subarray(0, 0x4c));
    header.writeUInt32LE(base.readUInt32LE(0x14) | 0x01 | 0x02, 0x14);
    const link = Buffer.concat([header, idList, linkInfo, base.subarray(0x4c)]);
    const patched = setShortcutArguments(link, 'new');
    expect(getShortcutArguments(patched)).toBe('new');
    expect(patched.subarray(0x4c, 0x4c + idList.length + linkInfo.length)).toEqual(Buffer.concat([idList, linkInfo]));
  });

  it('rejects files that are not Unicode shell links', () => {
    expect(() => setShortcutArguments(Buffer.from('not a link'), 'x')).toThrow(/not a shell link/);
    const ansi = makeLink({});
    ansi.writeUInt32LE(0, 0x14);
    expect(() => setShortcutArguments(ansi, 'x')).toThrow(/Unicode/);
  });
});

describe('fileUrl', () => {
  it('builds the file:/// URL Windows Terminal hands to ShellExecute', () => {
    const url = fileUrl(path.join(path.parse(process.cwd()).root, 'Users', 'Ann Lee', 'é', 'x-cmd.lnk'));
    expect(url).toMatch(/^file:\/\/\/.*\/Users\/Ann%20Lee\/%C3%A9\/x-cmd\.lnk$/);
  });
});

describe('ButtonShortcuts', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => removeDir(dir));

  const template = makeLink({ relPath: 'wscript.exe' });

  it('writes one shortcut per button that runs the handler with the button’s link', () => {
    const linksDir = path.join(dir, 'links');
    fs.mkdirSync(linksDir);
    fs.writeFileSync(path.join(linksDir, 'stale-cmd.lnk'), 'old daemon');
    const shortcuts = new ButtonShortcuts(template, 'C:\\h\\open.js', linksDir);
    expect(fs.readdirSync(linksDir)).toEqual([]); // cleared

    const url = shortcuts.urlFor('0f3c-9a', 'cmd', 'clipcmd://copy?id=0f3c-9a&type=cmd')!;
    const file = path.join(linksDir, '0f3c-9a-cmd.lnk');
    expect(url).toBe(fileUrl(file));
    expect(getShortcutArguments(fs.readFileSync(file))).toBe(
      handlerArguments('C:\\h\\open.js', 'clipcmd://copy?id=0f3c-9a&type=cmd')
    );
    shortcuts.urlFor('0f3c-9a', 'select', 'clipcmd://select?id=0f3c-9a');
    shortcuts.urlFor('other', 'cmd', 'clipcmd://copy?id=other&type=cmd');

    shortcuts.forget('0f3c-9a');
    expect(fs.readdirSync(linksDir)).toEqual(['other-cmd.lnk']);
  });

  it('refuses ids and button names that are not plain file-name material', () => {
    const shortcuts = new ButtonShortcuts(template, 'open.js', path.join(dir, 'links'));
    expect(shortcuts.urlFor('..\\..\\evil', 'cmd', 'x')).toBeUndefined();
    expect(shortcuts.urlFor('id', 'cmd/../x', 'x')).toBeUndefined();
    expect(fs.readdirSync(path.join(dir, 'links'))).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'win32')('the real shortcut template (Windows)', () => {
  let dir: string;
  const saved = process.env.CLIPCMD_CONFIG_DIR;
  beforeEach(() => {
    dir = makeTempDir();
    process.env.CLIPCMD_CONFIG_DIR = dir;
  });
  afterEach(() => {
    process.env.CLIPCMD_CONFIG_DIR = saved;
    removeDir(dir);
  });

  it('is written by Windows, and Windows reads back the arguments we patch in', () => {
    expect(createShortcutTemplate()).toBeUndefined();
    const template = fs.readFileSync(getShortcutTemplatePath());
    const link = path.join(dir, 'patched.lnk');
    const args = handlerArguments('C:\\x y\\open.js', 'clipcmd-vitest://copy?id=1-2&type=both');
    fs.writeFileSync(link, setShortcutArguments(template, args));

    const read = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${link}'); $s.TargetPath; $s.Arguments`],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 }
    );
    const [target, readArgs] = read.stdout.trim().split(/\r?\n/);
    expect(target.toLowerCase()).toMatch(/\\system32\\wscript\.exe$/);
    expect(readArgs).toBe(args);
  }, 90000);
});
