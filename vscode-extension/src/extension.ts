import * as vscode from 'vscode';
import { runCli } from './cli';
import { DaemonState, DaemonStatus, getDaemonStatus } from './daemonClient';
import { announceToDaemon, captureTerminalOutput } from './outputCapture';

/** Tells the daemon a VS Code window can deliver output (it forgets after 5 minutes). */
const ANNOUNCE_INTERVAL_MS = 60 * 1000;

export const INSTALL_GUIDE_URL = 'https://github.com/Djain912/clipcmd#readme';

const START_ACTION = 'Start Daemon';
const INSTALL_ACTION = 'How to Install';

/** States that `clipcmd start` fixes (not a hung daemon, which it would not replace). */
const STARTABLE: ReadonlySet<DaemonState> = new Set(['not-running', 'stale', 'unreachable', 'invalid-port-file']);

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('clipcmd.checkDaemon', checkDaemon),
    vscode.commands.registerCommand('clipcmd.startDaemon', startDaemon)
  );

  // Hooks cannot see command output; VS Code's shell integration can.
  context.subscriptions.push(captureTerminalOutput({ window: vscode.window }));
  announceToDaemon();
  const timer = setInterval(announceToDaemon, ANNOUNCE_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  void allowClipcmdLinks();
}

/**
 * The copy buttons are clipcmd:// links. VS Code asks before opening a
 * terminal link with a scheme it does not know; allow ours once.
 */
export async function allowClipcmdLinks(): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminal.integrated');
  const schemes = config.get<string[]>('allowedLinkSchemes') ?? [];
  if (schemes.includes('clipcmd')) return;
  try {
    await config.update('allowedLinkSchemes', [...schemes, 'clipcmd'], vscode.ConfigurationTarget.Global);
  } catch {
    // Settings not writable (e.g. policy); VS Code will ask on the first click instead.
  }
}

function cliPath(): string {
  return vscode.workspace.getConfiguration('clipcmd').get<string>('cliPath') ?? '';
}

/**
 * Reports the daemon status in a notification and returns it, so the command
 * is also usable from other extensions and tests via executeCommand. When
 * starting the daemon would help, the warning offers to.
 */
export async function checkDaemon(): Promise<DaemonStatus> {
  const status = await getDaemonStatus();
  // Not awaited: the notification resolves only when dismissed.
  if (status.available) {
    void vscode.window.showInformationMessage(status.message);
  } else if (STARTABLE.has(status.state)) {
    void vscode.window.showWarningMessage(status.message, START_ACTION).then((choice) => {
      if (choice === START_ACTION) void startDaemon();
    });
  } else {
    void vscode.window.showWarningMessage(status.message);
  }
  return status;
}

export interface StartResult {
  ok: boolean;
  message: string;
}

/**
 * Runs `clipcmd start` and reports the outcome. If the CLI is missing, says
 * how to install it.
 */
export async function startDaemon(): Promise<StartResult> {
  const result = await runCli(['start'], cliPath());
  if (result.notFound) {
    const message =
      'The clipcmd CLI was not found. Install it with `npm install -g clipcmd`, then run `clipcmd init` in your terminal ' +
      '(or set "clipcmd.cliPath" to its location).';
    void vscode.window.showWarningMessage(message, INSTALL_ACTION).then((choice) => {
      if (choice === INSTALL_ACTION) void vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE_URL));
    });
    return { ok: false, message };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
    const message = `clipcmd could not start the daemon: ${detail}`;
    void vscode.window.showWarningMessage(message);
    return { ok: false, message };
  }
  const message = result.stdout.trim() || 'clipcmd daemon started.';
  void vscode.window.showInformationMessage(message);
  return { ok: true, message };
}

export function deactivate() {}
