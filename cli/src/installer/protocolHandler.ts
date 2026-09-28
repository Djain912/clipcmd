import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfigDir, getPortFile } from '../config/paths';

/**
 * Windows `clipcmd://` link handler.
 *
 * Buttons that are http:// links make the terminal open a browser tab on
 * every click. Instead, `clipcmd init` registers a per-user URL protocol
 * whose handler is a tiny JScript file run by wscript.exe — a GUI program, so
 * no window flashes — which forwards the click to the daemon over HTTP.
 * Registration lives under HKCU\Software\Classes and needs no admin rights.
 */

/** URL scheme of the buttons; CLIPCMD_URL_SCHEME overrides it (tests use a throwaway name). */
export function urlScheme(): string {
  const override = process.env.CLIPCMD_URL_SCHEME;
  return override && /^[a-z][a-z0-9+.-]{0,31}$/.test(override) ? override : 'clipcmd';
}

export const DEFAULT_SCHEME = 'clipcmd';

export function getProtocolDir(): string {
  return path.join(getConfigDir(), 'protocol');
}

export function getHandlerScriptPath(): string {
  return path.join(getProtocolDir(), 'open.js');
}

/** True once `clipcmd init` has installed the handler (the daemon then emits clipcmd:// links). */
export function isProtocolHandlerInstalled(): boolean {
  return process.platform === 'win32' && fs.existsSync(getHandlerScriptPath());
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

function reg(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/**
 * Writes the handler script and registers `{scheme}://` for the current user.
 * Returns an error message on failure (nothing is left half-registered).
 */
export function registerProtocolHandler(scheme: string = urlScheme()): string | undefined {
  if (process.platform !== 'win32') return 'clipcmd:// links are only set up on Windows';
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
    const { ok, output } = reg(step);
    if (!ok) {
      unregisterProtocolHandler(scheme);
      return `Could not register ${scheme}:// links: ${output}`;
    }
  }
  return undefined;
}

/** Removes the registration and the handler script. */
export function unregisterProtocolHandler(scheme: string = urlScheme()): void {
  if (process.platform !== 'win32') return;
  reg(['delete', `HKCU\\Software\\Classes\\${scheme}`, '/f']);
  fs.rmSync(getHandlerScriptPath(), { force: true });
}

/** The command Windows runs for `{scheme}://` links, or undefined if unregistered. */
export function getRegisteredCommand(scheme: string = urlScheme()): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const { ok, output } = reg(['query', `HKCU\\Software\\Classes\\${scheme}\\shell\\open\\command`, '/ve']);
  if (!ok) return undefined;
  const match = /REG_SZ\s+(.*)$/m.exec(output);
  return match ? match[1].trim() : undefined;
}
