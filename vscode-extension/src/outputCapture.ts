import * as http from 'node:http';
import type * as vscode from 'vscode';
import { getDaemonPortInfo } from './daemonClient';

/** The button line the clipcmd hooks print after each command (and the one-time hint). */
const CLIPCMD_LINE = /^(\[COPY CMD\]( \[COPY OUTPUT\] \[COPY BOTH\])? \[\+\]|clipcmd: .*)\s*$/;

/** Keep at most this much output per command. */
const MAX_OUTPUT_CHARS = 1024 * 1024;

/**
 * Turns the raw terminal data of one command (from VS Code's shell
 * integration) into the plain text that was displayed: escape sequences
 * (colors, hyperlinks, VS Code's own markers) are removed, a carriage return
 * overwrites the line from its start (progress bars keep their final state),
 * and clipcmd's own button line at the end is dropped.
 */
export function cleanTerminalOutput(raw: string): string {
  const withoutEscapes = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: 633 markers, OSC 8 links, titles
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI: colors, cursor movement
    .replace(/\x1b[@-Z\\-_]/g, '') // other two-byte escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '');

  const lines = withoutEscapes.replace(/\r+\n/g, '\n').split('\n').map(overwriteCarriageReturns);
  while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || CLIPCMD_LINE.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  return lines.map((line) => line.trimEnd()).join('\n');
}

/** "abc\rX" displays as "Xbc". */
function overwriteCarriageReturns(line: string): string {
  if (!line.includes('\r')) return line;
  let shown = '';
  for (const part of line.split('\r')) {
    shown = part + shown.slice(part.length);
  }
  return shown;
}

/** POST the output to the daemon; best-effort, never throws. */
function postOutput(sid: string | undefined, cmd: string, text: string): void {
  const info = getDaemonPortInfo();
  if (!info) return;
  const query = new URLSearchParams({ cmd });
  if (sid) query.set('sid', sid);
  const req = http.request(
    {
      host: '127.0.0.1',
      port: info.port,
      method: 'POST',
      path: `/output?${query}`,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      agent: false,
      timeout: 3000,
    },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(text);
}

/** GET /client?kind=vscode so the daemon shows the output buttons in VS Code terminals. */
export function announceToDaemon(): void {
  const info = getDaemonPortInfo();
  if (!info) return;
  const req = http.get({ host: '127.0.0.1', port: info.port, path: '/client?kind=vscode', agent: false, timeout: 2000 }, (res) =>
    res.resume()
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
}

export interface CaptureDeps {
  window: Pick<typeof vscode.window, 'onDidStartTerminalShellExecution'>;
  send?: (sid: string | undefined, cmd: string, text: string) => void;
}

/**
 * Reads every command's output from VS Code's shell integration and sends it
 * to the daemon, which attaches it to the matching command so [COPY OUTPUT]
 * and [COPY BOTH] work in VS Code's terminal.
 */
export function captureTerminalOutput({ window, send = postOutput }: CaptureDeps): vscode.Disposable {
  return window.onDidStartTerminalShellExecution(async (event) => {
    // read() must be called right away so no output is missed
    const stream = event.execution.read();
    let raw = '';
    try {
      for await (const chunk of stream) {
        raw += chunk;
        if (raw.length > MAX_OUTPUT_CHARS * 2) raw = raw.slice(-MAX_OUTPUT_CHARS * 2);
      }
    } catch {
      return;
    }
    const cmd = event.execution.commandLine.value.trim();
    if (!cmd) return;
    let text = cleanTerminalOutput(raw);
    if (text.length > MAX_OUTPUT_CHARS) text = text.slice(-MAX_OUTPUT_CHARS);
    const pid = await event.terminal.processId;
    send(pid !== undefined ? String(pid) : undefined, cmd, text);
  });
}
