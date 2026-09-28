import * as vscode from 'vscode';
import { DaemonStatus, getDaemonStatus } from './daemonClient';
import { announceToDaemon, captureTerminalOutput } from './outputCapture';

/** Tells the daemon a VS Code window can deliver output (it forgets after 5 minutes). */
const ANNOUNCE_INTERVAL_MS = 60 * 1000;

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('clipcmd.checkDaemon', checkDaemon));

  // Hooks cannot see command output; VS Code's shell integration can.
  context.subscriptions.push(captureTerminalOutput({ window: vscode.window }));
  announceToDaemon();
  const timer = setInterval(announceToDaemon, ANNOUNCE_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  void allowClipcmdLinks();
}

/**
 * On Windows the copy buttons are clipcmd:// links. VS Code asks before
 * opening a terminal link with a scheme it does not know; allow ours once.
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

/**
 * Reports the daemon status in a notification and returns it, so the command
 * is also usable from other extensions and tests via executeCommand.
 */
export async function checkDaemon(): Promise<DaemonStatus> {
  const status = await getDaemonStatus();
  // Not awaited: the notification resolves only when dismissed.
  if (status.available) {
    void vscode.window.showInformationMessage(status.message);
  } else {
    void vscode.window.showWarningMessage(status.message);
  }
  return status;
}

export function deactivate() {}
