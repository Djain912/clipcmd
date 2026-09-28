import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPowerShellInfo } from './powershell';
import { isPowerShell, SupportedShell } from './shellDetector';

export const HOOK_START_MARKER = '# === CLIPCMD HOOK START ===';
export const HOOK_END_MARKER = '# === CLIPCMD HOOK END ===';

/**
 * Thrown when a config file has a START marker without a matching END marker.
 * We refuse to guess where the block ends rather than risk deleting the
 * user's own configuration.
 */
export class MalformedHookBlockError extends Error {
  constructor(configPath: string) {
    super(
      `${configPath} contains "${HOOK_START_MARKER}" without a matching "${HOOK_END_MARKER}". ` +
        'Remove the partial clipcmd block manually, then run the command again.'
    );
    this.name = 'MalformedHookBlockError';
    Object.setPrototypeOf(this, MalformedHookBlockError.prototype);
  }
}

/**
 * Returns the absolute path to the shell config file for the given shell.
 */
export function getConfigPath(shell: SupportedShell): string {
  const home = os.homedir();
  switch (shell) {
    case 'zsh':
      return path.join(home, '.zshrc');
    case 'bash':
      return path.join(home, '.bashrc');
    case 'fish':
      return path.join(home, '.config', 'fish', 'config.fish');
    case 'powershell':
    case 'pwsh':
      return getPowerShellInfo(shell).profile;
  }
}

/**
 * Returns the absolute path to the hook source file for the given shell.
 * Hooks live at the package root: hooks/{name}.{ext}. This resolves the same
 * from dist/installer/ (installed package) and src/installer/ (tests).
 */
export function getHookFilePath(shell: SupportedShell): string {
  const file = isPowerShell(shell) ? 'powershell.ps1' : shell === 'fish' ? 'fish.fish' : `${shell}.sh`;
  return path.resolve(__dirname, '../../hooks', file);
}

type TextEncoding = 'utf16le' | 'utf16be' | 'utf8bom' | 'bytes';

/**
 * Reads a config file without assuming its encoding, so it can be written
 * back unchanged apart from our block. Windows PowerShell 5.1's `>` writes
 * UTF-16LE; other files may be UTF-8 (with or without BOM) or a legacy code
 * page. Anything that is not UTF-16/BOM is handled as raw bytes (latin1), which
 * round-trips every byte; our markers and hook text are ASCII.
 */
export function readConfigText(file: string): { text: string; encoding: TextEncoding } {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('latin1'), encoding: 'utf8bom' };
  }
  return { text: buf.toString('latin1'), encoding: 'bytes' };
}

export function writeConfigText(file: string, text: string, encoding: TextEncoding): void {
  let buf: Buffer;
  switch (encoding) {
    case 'utf16le':
      buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
      break;
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le');
      body.swap16();
      buf = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
      break;
    }
    case 'utf8bom':
      buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'latin1')]);
      break;
    case 'bytes':
      buf = Buffer.from(text, 'latin1');
      break;
  }
  // writeFileSync follows symlinks, so dotfile-manager links stay intact.
  fs.writeFileSync(file, buf);
}

/** Wraps hook content in the markers, one block terminated by a newline. */
function buildBlock(hookContent: string): string {
  // Shells choke on CRLF (`$'\r': command not found`), e.g. after a Windows checkout.
  const body = hookContent.replace(/\r\n/g, '\n').trimEnd();
  return `${HOOK_START_MARKER}\n${body}\n${HOOK_END_MARKER}\n`;
}

/**
 * Locates every hook block as [start, end) offsets. A block spans from the
 * START marker through the END marker and the newline that follows it.
 */
function findBlocks(content: string, configPath: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const start = content.indexOf(HOOK_START_MARKER, from);
    if (start === -1) return blocks;
    const endMarker = content.indexOf(HOOK_END_MARKER, start + HOOK_START_MARKER.length);
    if (endMarker === -1) throw new MalformedHookBlockError(configPath);
    let end = endMarker + HOOK_END_MARKER.length;
    if (content.startsWith('\r\n', end)) end += 2;
    else if (content.startsWith('\n', end)) end += 1;
    blocks.push([start, end]);
    from = end;
  }
}

/**
 * Pure transform used by install(): replaces the first existing hook block
 * (dropping any duplicates) or appends a new one at the end.
 * Requirements: 2.2, 2.3, 2.4, 2.5
 */
export function applyHookBlock(content: string, hookContent: string, configPath = 'shell config'): string {
  const block = buildBlock(hookContent);
  const blocks = findBlocks(content, configPath);

  if (blocks.length === 0) {
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    return content + separator + block;
  }

  let result = content.slice(0, blocks[0][0]) + block;
  for (let i = 0; i < blocks.length; i++) {
    const nextStart = i + 1 < blocks.length ? blocks[i + 1][0] : content.length;
    result += content.slice(blocks[i][1], nextStart);
  }
  return result;
}

/**
 * Pure transform used by uninstall(): removes every hook block, leaving all
 * other content byte-for-byte intact.
 * Requirement: 2.9
 */
export function removeHookBlock(content: string, configPath = 'shell config'): string {
  const blocks = findBlocks(content, configPath);
  let result = '';
  let from = 0;
  for (const [start, end] of blocks) {
    result += content.slice(from, start);
    from = end;
  }
  return result + content.slice(from);
}

export type InstallResult = 'installed' | 'updated' | 'unchanged';

/**
 * Installs (or refreshes) the shell hook in the shell's config file.
 * Re-running replaces the existing block, so upgrading clipcmd and running
 * `clipcmd init` again picks up the new hook (Requirement 2.5).
 */
export function install(shell: SupportedShell): InstallResult {
  // Hooks are ASCII; read as bytes to match readConfigText's byte-preserving text
  const hookContent = fs.readFileSync(getHookFilePath(shell), 'latin1');
  const configPath = getConfigPath(shell);

  const { text: existing, encoding } = fs.existsSync(configPath)
    ? readConfigText(configPath)
    : { text: '', encoding: 'bytes' as const };
  const wasInstalled = existing.includes(HOOK_START_MARKER);
  // The PowerShell hook wraps the prompt function, so it must run after any
  // prompt customization in the profile: always move its block to the end.
  const base = isPowerShell(shell) ? removeHookBlock(existing, configPath) : existing;
  const updated = applyHookBlock(base, hookContent, configPath);

  if (updated === existing) return 'unchanged';

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfigText(configPath, updated, encoding);
  return wasInstalled ? 'updated' : 'installed';
}

/**
 * Removes the clipcmd hook block from the shell's config file.
 * Returns true if a block was removed.
 * Requirement: 2.9
 */
export function uninstall(shell: SupportedShell): boolean {
  const configPath = getConfigPath(shell);
  if (!fs.existsSync(configPath)) return false;

  const { text: existing, encoding } = readConfigText(configPath);
  if (!existing.includes(HOOK_START_MARKER)) return false;

  writeConfigText(configPath, removeHookBlock(existing, configPath), encoding);
  return true;
}

/**
 * Returns true if the clipcmd hook block is present in the shell's config file.
 */
export function isInstalled(shell: SupportedShell): boolean {
  try {
    return readConfigText(getConfigPath(shell)).text.includes(HOOK_START_MARKER);
  } catch {
    return false;
  }
}

/**
 * The Installer object implementing the Installer interface from the design.
 */
export const installer = {
  install,
  uninstall,
  isInstalled,
};

export default installer;
