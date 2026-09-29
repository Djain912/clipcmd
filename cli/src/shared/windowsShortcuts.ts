import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfigDir } from '../config/paths';

/**
 * Copy buttons for Windows Terminal, as .lnk shortcuts.
 *
 * Windows Terminal is a packaged (Store) app, and Windows resolves the links
 * a packaged app opens without the current user's own registrations
 * (HKCU\Software\Classes): a Ctrl+click on a clipcmd:// link there ends in
 * "Get an app to open this 'clipcmd' link", however the scheme is registered.
 * Windows Terminal does open file:// links (.lnk is not in PATHEXT, so
 * without a warning), and a shortcut runs its target directly, without any
 * lookup. So in Windows Terminal each button links to a small shortcut that
 * runs the clipcmd:// handler (wscript.exe + open.js) with that button's link.
 */

/** Folder of the per-button shortcuts. */
export function getButtonShortcutDir(): string {
  return path.join(getConfigDir(), 'links');
}

/** The shortcut that button shortcuts are copied from (written by `clipcmd init`). */
export function getShortcutTemplatePath(): string {
  return path.join(getConfigDir(), 'protocol', 'button.lnk');
}

function wscriptPath(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
}

/** Arguments that make wscript run the handler script with one button's link. */
export function handlerArguments(handlerScript: string, link: string): string {
  return `//B //NoLogo "${handlerScript}" "${link}"`;
}

// JScript run by cscript.exe: Windows itself writes the template shortcut.
const MAKE_SHORTCUT_JS = [
  '// Writes the template for clipcmd button shortcuts. Run by `clipcmd init`.',
  'var sh = new ActiveXObject("WScript.Shell");',
  'var lnk = sh.CreateShortcut(WScript.Arguments(0));',
  'lnk.TargetPath = WScript.Arguments(1);',
  'lnk.Arguments = WScript.Arguments(2);',
  'lnk.WindowStyle = 7;',
  'lnk.Description = "clipcmd copy button";',
  'lnk.Save();',
  '',
].join('\r\n');

function templateCommand(): { file: string; args: string[] } {
  const template = getShortcutTemplatePath();
  const script = path.join(path.dirname(template), 'make-shortcut.js');
  fs.mkdirSync(path.dirname(template), { recursive: true });
  fs.writeFileSync(script, MAKE_SHORTCUT_JS, 'utf8');
  const cscript = path.join(path.dirname(wscriptPath()), 'cscript.exe');
  return { file: cscript, args: ['//B', '//NoLogo', script, template, wscriptPath(), 'clipcmd'] };
}

/** Writes the template shortcut. Returns an error message on failure. */
export function createShortcutTemplate(): string | undefined {
  const { file, args } = templateCommand();
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status === 0 && fs.existsSync(getShortcutTemplatePath())) return undefined;
  return `Could not create the Windows Terminal button shortcut: ${`${result.stderr ?? ''}${result.error?.message ?? ''}`.trim() || `exit code ${result.status}`}`;
}

export function removeShortcutFiles(): void {
  fs.rmSync(getShortcutTemplatePath(), { force: true });
  fs.rmSync(path.join(path.dirname(getShortcutTemplatePath()), 'make-shortcut.js'), { force: true });
  fs.rmSync(getButtonShortcutDir(), { recursive: true, force: true });
}

// MS-SHLLINK: https://learn.microsoft.com/openspecs/windows_protocols/ms-shllink
const HEADER_SIZE = 0x4c;
const FLAGS_OFFSET = 0x14;
const HAS_ID_LIST = 0x01;
const HAS_LINK_INFO = 0x02;
const HAS_ARGUMENTS = 0x20;
const IS_UNICODE = 0x80;
/** StringData entries, in file order: NAME, RELATIVE_PATH, WORKING_DIR, ARGUMENTS, ICON_LOCATION. */
const STRING_FLAGS = [0x04, 0x08, 0x10, HAS_ARGUMENTS, 0x40];

/** Returns a copy of a (Unicode) shell link with its command-line arguments replaced. */
export function setShortcutArguments(template: Buffer, args: string): Buffer {
  if (template.length < HEADER_SIZE || template.readUInt32LE(0) !== HEADER_SIZE) {
    throw new Error('not a shell link (.lnk) file');
  }
  let flags = template.readUInt32LE(FLAGS_OFFSET);
  if (!(flags & IS_UNICODE)) throw new Error('the shortcut template must use Unicode strings');
  if (args.length > 0xffff) throw new Error('shortcut arguments are too long');

  let offset = HEADER_SIZE;
  if (flags & HAS_ID_LIST) offset += 2 + template.readUInt16LE(offset);
  if (flags & HAS_LINK_INFO) offset += template.readUInt32LE(offset);
  const beforeStrings = template.subarray(HEADER_SIZE, offset);

  const strings = new Map<number, Buffer>();
  for (const flag of STRING_FLAGS) {
    if (!(flags & flag)) continue;
    const length = 2 + template.readUInt16LE(offset) * 2;
    strings.set(flag, template.subarray(offset, offset + length));
    offset += length;
  }
  if (offset > template.length) throw new Error('truncated shell link (.lnk) file');

  const argument = Buffer.alloc(2 + args.length * 2);
  argument.writeUInt16LE(args.length, 0);
  argument.write(args, 2, 'utf16le');
  strings.set(HAS_ARGUMENTS, argument);
  flags |= HAS_ARGUMENTS;

  const header = Buffer.from(template.subarray(0, HEADER_SIZE));
  header.writeUInt32LE(flags >>> 0, FLAGS_OFFSET);
  const ordered = STRING_FLAGS.filter((f) => strings.has(f)).map((f) => strings.get(f) as Buffer);
  return Buffer.concat([header, beforeStrings, ...ordered, template.subarray(offset)]);
}

/** Reads a shell link's command-line arguments (for tests and `clipcmd doctor`). */
export function getShortcutArguments(link: Buffer): string | undefined {
  const flags = link.readUInt32LE(FLAGS_OFFSET);
  if (!(flags & HAS_ARGUMENTS)) return undefined;
  let offset = HEADER_SIZE;
  if (flags & HAS_ID_LIST) offset += 2 + link.readUInt16LE(offset);
  if (flags & HAS_LINK_INFO) offset += link.readUInt32LE(offset);
  for (const flag of STRING_FLAGS) {
    if (!(flags & flag)) continue;
    const count = link.readUInt16LE(offset);
    if (flag === HAS_ARGUMENTS) return link.subarray(offset + 2, offset + 2 + count * 2).toString('utf16le');
    offset += 2 + count * 2;
  }
  return undefined;
}

/** file:/// URL for a local path, as Windows Terminal passes it to ShellExecute. */
export function fileUrl(filePath: string): string {
  const parts = path.resolve(filePath).split(/[\\/]+/);
  const [drive, ...rest] = parts;
  return `file:///${drive}/${rest.map(encodeURIComponent).join('/')}`;
}

export interface ButtonLinks {
  /** URL of a shortcut that opens `link` through the handler, or undefined to keep `link`. */
  urlFor(blockId: string, button: string, link: string): string | undefined;
  /** Removes an evicted block's shortcuts. */
  forget(blockId: string): void;
}

/**
 * Writes one shortcut per button into the links folder (cleared on creation:
 * shortcuts of a previous daemon point at blocks that no longer exist).
 */
export class ButtonShortcuts implements ButtonLinks {
  private readonly written = new Map<string, string[]>();

  constructor(
    private readonly template: Buffer,
    private readonly handlerScript: string,
    private readonly dir: string = getButtonShortcutDir(),
    private readonly log: (message: string) => void = () => {}
  ) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  urlFor(blockId: string, button: string, link: string): string | undefined {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(blockId) || !/^[a-z-]{1,16}$/.test(button)) return undefined;
    const file = path.join(this.dir, `${blockId}-${button}.lnk`);
    try {
      fs.writeFileSync(file, setShortcutArguments(this.template, handlerArguments(this.handlerScript, link)));
    } catch (err) {
      this.log(`Could not write button shortcut: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const files = this.written.get(blockId) ?? [];
    files.push(file);
    this.written.set(blockId, files);
    return fileUrl(file);
  }

  forget(blockId: string): void {
    for (const file of this.written.get(blockId) ?? []) fs.rmSync(file, { force: true });
    this.written.delete(blockId);
  }
}

/**
 * The daemon's button shortcuts (Windows only), set up on first use: most
 * sessions never need them, and `clipcmd init` may run after the daemon.
 */
export function lazyButtonShortcuts(handlerScript: string, log: (message: string) => void): ButtonLinks | undefined {
  if (process.platform !== 'win32') return undefined;
  let shortcuts: ButtonShortcuts | null | undefined;
  const get = (): ButtonShortcuts | null => {
    if (shortcuts !== undefined) return shortcuts;
    const templatePath = getShortcutTemplatePath();
    // Missing after an upgrade that skipped `clipcmd init`: make it now (once)
    const error = fs.existsSync(templatePath) ? undefined : createShortcutTemplate();
    try {
      if (error) throw new Error(error);
      shortcuts = new ButtonShortcuts(fs.readFileSync(templatePath), handlerScript, getButtonShortcutDir(), log);
    } catch (err) {
      log(`Windows Terminal buttons fall back to clipcmd:// links: ${err instanceof Error ? err.message : String(err)}`);
      shortcuts = null;
    }
    return shortcuts;
  };
  return {
    urlFor: (blockId, button, link) => get()?.urlFor(blockId, button, link),
    forget: (blockId) => shortcuts?.forget(blockId),
  };
}
