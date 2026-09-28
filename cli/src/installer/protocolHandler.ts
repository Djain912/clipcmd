import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfigDir, getPortFile } from '../config/paths';

/**
 * `clipcmd://` link handler, so a click on a copy button copies silently
 * instead of opening a browser tab.
 *
 * - Windows: a per-user URL protocol (HKCU\Software\Classes, no admin) whose
 *   handler is a tiny JScript file run by wscript.exe — a GUI program, so no
 *   window flashes — which forwards the click to the daemon over HTTP.
 * - Linux: a hidden .desktop entry for x-scheme-handler/clipcmd, set as the
 *   default with xdg-mime; it runs `clipcmd open <url>`.
 * - macOS: a tiny background AppleScript app in ~/Applications that declares
 *   the URL scheme and runs `clipcmd open <url>`.
 */

/** URL scheme of the buttons; CLIPCMD_URL_SCHEME overrides it (tests use a throwaway name). */
export function urlScheme(): string {
  const override = process.env.CLIPCMD_URL_SCHEME;
  return override && /^[a-z][a-z0-9+.-]{0,31}$/.test(override) ? override : 'clipcmd';
}

export const DEFAULT_SCHEME = 'clipcmd';

/** Button actions a link may trigger. */
const ACTIONS = ['copy', 'select', 'copy-selected'];

/**
 * Parses a button link such as clipcmd://copy?id=..&type=cmd. Windows may
 * normalize it to clipcmd://copy/?id=..; only the three button actions with a
 * plain query string are accepted.
 */
export function parseButtonUrl(url: string): { action: string; query: string } | undefined {
  const match = /^[a-z][a-z0-9.+-]*:\/*([a-z-]+)\/?\??(.*)$/i.exec(url.trim());
  if (!match) return undefined;
  const action = match[1].toLowerCase();
  const query = match[2];
  if (!ACTIONS.includes(action) || !/^[A-Za-z0-9._~%&=-]*$/.test(query)) return undefined;
  return { action, query };
}

/** bin/clipcmd.js of this installation (the Linux and macOS handlers run it). */
export function cliEntry(): string {
  return path.resolve(__dirname, '../../bin/clipcmd.js');
}

// ---------------------------------------------------------------- Windows

export function getProtocolDir(): string {
  return path.join(getConfigDir(), 'protocol');
}

export function getHandlerScriptPath(): string {
  return path.join(getProtocolDir(), 'open.js');
}

/** The JScript handler. It only forwards the three button actions, with a plain query string. */
export function handlerScript(portFile: string): string {
  const portFileLiteral = JSON.stringify(portFile);
  return [
    '// clipcmd:// link handler, written by `clipcmd init`. Runs under wscript.exe (no window).',
    '// Forwards clipcmd://copy?id=..&type=.. and clipcmd://select?id=.. to the clipcmd daemon.',
    `var PORT_FILE = ${portFileLiteral};`,
    'function main() {',
    '  if (WScript.Arguments.length < 1) return;',
    '  // Windows may normalize "clipcmd://copy?x" to "clipcmd://copy/?x"',
    '  var m = /^[a-z][a-z0-9.+-]*:\\/*([a-z-]+)\\/?\\??(.*)$/i.exec(String(WScript.Arguments(0)));',
    '  if (!m) return;',
    '  var action = m[1].toLowerCase();',
    '  if (action != "copy" && action != "select" && action != "copy-selected") return;',
    '  var query = m[2];',
    '  if (!/^[A-Za-z0-9._~%&=-]*$/.test(query)) return;',
    '  var fso = new ActiveXObject("Scripting.FileSystemObject");',
    '  if (!fso.FileExists(PORT_FILE)) return;',
    '  var file = fso.OpenTextFile(PORT_FILE, 1);',
    '  var content = file.AtEndOfStream ? "" : file.ReadAll();',
    '  file.Close();',
    '  var port = /^\\s*(\\d{1,5})/.exec(content);',
    '  if (!port) return;',
    '  var http = new ActiveXObject("WinHttp.WinHttpRequest.5.1");',
    '  http.SetTimeouts(1000, 1000, 3000, 3000);',
    '  http.Open("GET", "http://127.0.0.1:" + port[1] + "/" + action + (query ? "?" + query : ""), false);',
    '  http.Send();',
    '}',
    'try { main(); } catch (e) {}',
    '',
  ].join('\r\n');
}

function run(file: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? result.error.message : ''}`.trim(),
  };
}

function registerWindows(scheme: string): string | undefined {
  const script = getHandlerScriptPath();
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, handlerScript(getPortFile()), 'utf8');

  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const key = `HKCU\\Software\\Classes\\${scheme}`;
  const steps = [
    ['add', key, '/ve', '/d', `URL:${scheme} (clipcmd copy buttons)`, '/f'],
    ['add', key, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', `${key}\\shell\\open\\command`, '/ve', '/d', `"${wscript}" //B //NoLogo "${script}" "%1"`, '/f'],
  ];
  for (const step of steps) {
    const { ok, output } = run('reg.exe', step);
    if (!ok) {
      unregisterWindows(scheme);
      return `Could not register ${scheme}:// links: ${output}`;
    }
  }
  return undefined;
}

function unregisterWindows(scheme: string): void {
  run('reg.exe', ['delete', `HKCU\\Software\\Classes\\${scheme}`, '/f']);
  fs.rmSync(getHandlerScriptPath(), { force: true });
}

/** The command Windows runs for `{scheme}://` links, or undefined if unregistered. */
export function getRegisteredCommand(scheme: string = urlScheme()): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const { ok, output } = run('reg.exe', ['query', `HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`, '/ve']);
  if (!ok) return undefined;
  const match = /REG_SZ\s+(.*)$/m.exec(output);
  return match ? match[1].trim() : undefined;
}

// ------------------------------------------------------------------ Linux

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export function linuxDesktopFile(scheme: string = urlScheme()): string {
  return path.join(xdgDataHome(), 'applications', `${scheme}-url-handler.desktop`);
}

/** Quotes an Exec argument per the Desktop Entry spec (string escapes, then quoting). */
function desktopQuote(arg: string): string {
  const quoted = arg.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%');
  return `"${quoted.replace(/\\/g, '\\\\')}"`;
}

export function desktopEntry(scheme: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=clipcmd copy buttons (${scheme}://)`,
    `Exec=${desktopQuote(process.execPath)} ${desktopQuote(cliEntry())} open %u`,
    'NoDisplay=true',
    'Terminal=false',
    `MimeType=x-scheme-handler/${scheme};`,
    '',
  ].join('\n');
}

function registerLinux(scheme: string): string | undefined {
  const file = linuxDesktopFile(scheme);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry(scheme), 'utf8');
  const { ok, output } = run('xdg-mime', ['default', path.basename(file), `x-scheme-handler/${scheme}`]);
  if (!ok) {
    fs.rmSync(file, { force: true });
    return `Could not register ${scheme}:// links (xdg-mime: ${output || 'not found'})`;
  }
  run('update-desktop-database', [path.dirname(file)]); // optional; speeds up lookups
  return undefined;
}

function unregisterLinux(scheme: string): void {
  fs.rmSync(linuxDesktopFile(scheme), { force: true });
  // Drop the default-application entry xdg-mime wrote
  const mimeapps = path.join(xdgConfigHome(), 'mimeapps.list');
  try {
    const text = fs.readFileSync(mimeapps, 'utf8');
    const kept = text.split('\n').filter((line) => !line.startsWith(`x-scheme-handler/${scheme}=`));
    if (kept.length !== text.split('\n').length) fs.writeFileSync(mimeapps, kept.join('\n'), 'utf8');
  } catch {
    // no mimeapps.list
  }
}

// ------------------------------------------------------------------ macOS

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export function macAppPath(scheme: string = urlScheme()): string {
  return path.join(os.homedir(), 'Applications', `${scheme} link handler.app`);
}

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function appleScriptSource(): string {
  return [
    'on open location theURL',
    `\tdo shell script (quoted form of ${appleScriptString(process.execPath)}) & " " & ` +
      `(quoted form of ${appleScriptString(cliEntry())}) & " open " & (quoted form of theURL)`,
    'end open location',
    '',
  ].join('\n');
}

function registerMac(scheme: string): string | undefined {
  const app = macAppPath(scheme);
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(app), { recursive: true });
  const source = path.join(os.tmpdir(), `clipcmd-${process.pid}.applescript`);
  fs.writeFileSync(source, appleScriptSource(), 'utf8');
  const compiled = run('osacompile', ['-o', app, source]);
  fs.rmSync(source, { force: true });
  if (!compiled.ok) return `Could not build the ${scheme}:// link handler app: ${compiled.output}`;

  const plist = path.join(app, 'Contents', 'Info.plist');
  const buddy = (command: string) => run('/usr/libexec/PlistBuddy', ['-c', command, plist]);
  buddy(`Set :CFBundleIdentifier dev.clipcmd.${scheme.replace(/[^A-Za-z0-9.-]/g, '-')}.linkhandler`);
  buddy('Add :LSUIElement bool true'); // no Dock icon
  buddy('Add :CFBundleURLTypes array');
  buddy('Add :CFBundleURLTypes:0 dict');
  buddy(`Add :CFBundleURLTypes:0:CFBundleURLName string ${scheme}`);
  buddy('Add :CFBundleURLTypes:0:CFBundleURLSchemes array');
  const added = buddy(`Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${scheme}`);
  if (!added.ok) {
    fs.rmSync(app, { recursive: true, force: true });
    return `Could not register ${scheme}:// links: ${added.output}`;
  }
  // Editing Info.plist breaks the ad-hoc signature osacompile made; sign again
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  const registered = run(LSREGISTER, ['-f', app]);
  if (!registered.ok) {
    fs.rmSync(app, { recursive: true, force: true });
    return `Could not register ${scheme}:// links: ${registered.output}`;
  }
  return undefined;
}

function unregisterMac(scheme: string): void {
  const app = macAppPath(scheme);
  if (fs.existsSync(app)) run(LSREGISTER, ['-u', app]);
  fs.rmSync(app, { recursive: true, force: true });
}

// ------------------------------------------------------------------ API

/** True once `clipcmd init` has installed the handler (the daemon then emits clipcmd:// links). */
export function isProtocolHandlerInstalled(): boolean {
  switch (process.platform) {
    case 'win32':
      return fs.existsSync(getHandlerScriptPath());
    case 'linux':
      return fs.existsSync(linuxDesktopFile());
    case 'darwin':
      return fs.existsSync(macAppPath());
    default:
      return false;
  }
}

/**
 * Registers `{scheme}://` links for the current user. Returns an error
 * message on failure (nothing is left half-registered).
 */
export function registerProtocolHandler(scheme: string = urlScheme()): string | undefined {
  switch (process.platform) {
    case 'win32':
      return registerWindows(scheme);
    case 'linux':
      return registerLinux(scheme);
    case 'darwin':
      return registerMac(scheme);
    default:
      return `${scheme}:// links are not supported on ${process.platform}`;
  }
}

/** Removes the registration. */
export function unregisterProtocolHandler(scheme: string = urlScheme()): void {
  switch (process.platform) {
    case 'win32':
      return unregisterWindows(scheme);
    case 'linux':
      return unregisterLinux(scheme);
    case 'darwin':
      return unregisterMac(scheme);
  }
}
