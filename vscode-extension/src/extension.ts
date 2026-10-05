import * as vscode from 'vscode';
import { runCli } from './cli';
import { DaemonState, DaemonStatus, getDaemonStatus } from './daemonClient';
import { announceToDaemon, captureTerminalOutput } from './outputCapture';

/** Tells the daemon a VS Code window can deliver output (it forgets after 5 minutes). */
const ANNOUNCE_INTERVAL_MS = 60 * 1000;

/** The website's install steps (both parts: the npm package and this extension). */
export const INSTALL_GUIDE_URL = 'https://djain912.github.io/clipcmd/#install';

const START_ACTION = 'Start Daemon';
const INSTALL_ACTION = 'How to Install';
const INSTALL_NOW = 'Install';
const SET_UP_NOW = 'Set Up';
const DONT_SHOW = "Don't Show Again";

/** globalState key: the user asked not to be told about a missing or unset-up CLI. */
const CLI_NOTICE_DISMISSED = 'clipcmd.cliNoticeDismissed';

/** Typed into a new terminal by the Install button: the npm package, then its shell setup. */
export const INSTALL_LINES = ['npm install -g clipcmd', 'clipcmd init'];
export const SET_UP_LINES = ['clipcmd init'];

/** What checkCli found: the CLI is ready, missing, installed but not set up, or the user muted the notice. */
export type CliCheck = 'ok' | 'missing' | 'not-set-up' | 'dismissed';

export interface CheckCliOptions {
  /** Runs commands in a new terminal (tests replace it so nothing is installed for real). */
  runInTerminal?: (lines: string[]) => void;
}

/** Returned by activate(), so tests and other extensions can run the check. */
export interface ClipcmdApi {
  checkCli(options?: CheckCliOptions): Promise<CliCheck>;
}

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

  // This extension is one half of clipcmd: say so when the other half is missing
  void checkCli(context.globalState);
  const api: ClipcmdApi = { checkCli: (options) => checkCli(context.globalState, options) };
  return api;
}

/**
 * The extension only captures output; the copy buttons come from the clipcmd
 * npm package and the shell hook that `clipcmd init` installs. When either is
 * missing, a notification says so and offers to fix it in a terminal. It
 * returns at once; the notification stays until answered.
 */
export async function checkCli(state: vscode.Memento, options: CheckCliOptions = {}): Promise<CliCheck> {
  if (state.get<boolean>(CLI_NOTICE_DISMISSED)) return 'dismissed';
  const run = options.runInTerminal ?? runInNewTerminal;
  const version = await runCli(['--version'], cliPath());
  if (version.notFound) {
    void vscode.window
      .showWarningMessage(
        'clipcmd needs its npm package: this extension captures output, but the copy buttons come from the clipcmd command (Node.js 20 or newer). Install it now?',
        INSTALL_NOW,
        INSTALL_ACTION,
        DONT_SHOW
      )
      .then((choice) => answer(choice, INSTALL_LINES));
    return 'missing';
  }
  // Installed: is it set up for a shell? (`clipcmd doctor` fails without a hook)
  const doctor = await runCli(['doctor'], cliPath());
  if (/No shell hook installed/.test(doctor.stdout + doctor.stderr)) {
    void vscode.window
      .showWarningMessage(
        'clipcmd is installed but not set up for your shell yet, so no copy buttons appear. Run `clipcmd init` now?',
        SET_UP_NOW,
        DONT_SHOW
      )
      .then((choice) => answer(choice, SET_UP_LINES));
    return 'not-set-up';
  }
  return 'ok';

  function answer(choice: string | undefined, lines: string[]): void {
    if (choice === INSTALL_NOW || choice === SET_UP_NOW) run(lines);
    else if (choice === INSTALL_ACTION) void vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE_URL));
    else if (choice === DONT_SHOW) void state.update(CLI_NOTICE_DISMISSED, true);
  }
}

/** Opens a terminal and types the commands; each runs after the one before. */
function runInNewTerminal(lines: string[]): void {
  const terminal = vscode.window.createTerminal({ name: 'clipcmd setup' });
  terminal.show();
  for (const line of lines) terminal.sendText(line);
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
