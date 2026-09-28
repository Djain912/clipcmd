import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPowerShell, resolveShellArg, UnsupportedShellError } from '../../installer/shellDetector';
import { getConfigPath, install, MalformedHookBlockError } from '../../installer/installer';
import { blocksProfileScripts, getPowerShellInfo } from '../../installer/powershell';
import { registerProtocolHandler, urlScheme } from '../../installer/protocolHandler';
import { allowSchemeInWindowsTerminal } from '../../installer/windowsTerminal';
import type { SupportedShell } from '../../installer/shellDetector';

/**
 * Returns the shell-specific instruction for reloading the config file.
 */
function reloadInstruction(shell: SupportedShell): string {
  switch (shell) {
    case 'zsh':
      return 'Restart your terminal or run: source ~/.zshrc';
    case 'bash':
      return 'Restart your terminal or run: source ~/.bashrc';
    case 'fish':
      return 'Restart your terminal or run: source ~/.config/fish/config.fish';
    case 'powershell':
    case 'pwsh':
      return 'Restart your terminal or run: . $PROFILE';
  }
}

/**
 * Implements `clipcmd init [shell]`.
 *
 * Detects the user's shell (or uses the one given), then installs the hook,
 * replacing an existing clipcmd block so re-running after an upgrade
 * refreshes it.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
export async function run(args: string[]): Promise<number> {
  let shell: SupportedShell;
  try {
    shell = resolveShellArg(args);
  } catch (err) {
    if (err instanceof UnsupportedShellError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  if (isPowerShell(shell)) {
    // Under these policies PowerShell refuses to run the profile and prints an
    // error in every new window. Changing the policy is the user's call.
    const { executionPolicy } = getPowerShellInfo(shell);
    if (blocksProfileScripts(executionPolicy)) {
      console.error(
        `PowerShell's execution policy is ${executionPolicy}, so it would not run the clipcmd hook ` +
          'from your profile. To allow local scripts for your account, run in PowerShell:\n' +
          '  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned\n' +
          'then run `clipcmd init` again.'
      );
      return 1;
    }
  }

  let result;
  try {
    result = install(shell);
  } catch (err) {
    if (err instanceof MalformedHookBlockError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const configPath = getConfigPath(shell);
  switch (result) {
    case 'unchanged':
      console.log(`clipcmd hook for ${shell} is already up to date in ${configPath}.`);
      break;
    case 'updated':
      console.log(`clipcmd hook for ${shell} updated in ${configPath}.`);
      break;
    case 'installed':
      console.log(`clipcmd hook installed successfully for ${shell} in ${configPath}.`);
      break;
  }
  setUpSilentLinks();
  if (result !== 'unchanged') console.log(reloadInstruction(shell));
  const warning = shell === 'bash' ? loginShellWarning() : undefined;
  if (warning) console.log(warning);
  return 0;
}

/**
 * Make the copy buttons work without opening a browser: register the
 * clipcmd:// handler and, on Windows, allow the scheme in Windows Terminal,
 * which otherwise asks for confirmation on every click.
 */
function setUpSilentLinks(): void {
  const scheme = urlScheme();
  const error = registerProtocolHandler(scheme);
  if (error) {
    console.log(`${error}\nButtons will open in your browser instead.`);
    return;
  }
  console.log(`Copy buttons now copy silently (${scheme}:// links, registered for your user).`);
  if (process.platform !== 'win32') return;

  for (const { file, status } of allowSchemeInWindowsTerminal(scheme)) {
    if (status === 'added') {
      console.log(`Windows Terminal: allowed ${scheme}:// links without confirmation ("safeUriSchemes" in ${file}).`);
    } else if (status === 'failed') {
      console.log(
        `Windows Terminal: could not edit ${file} safely. Add "safeUriSchemes": ["${scheme}"] to it\n` +
          'yourself, or Windows Terminal will ask before opening each button.'
      );
    }
  }
}

/**
 * Terminals that start bash as a login shell (macOS Terminal, Git Bash) read
 * ~/.bash_profile, not ~/.bashrc. Warn when ~/.bash_profile exists but does
 * not appear to load ~/.bashrc, since the hook would then never run.
 */
export function loginShellWarning(home: string = os.homedir()): string | undefined {
  const profile = path.join(home, '.bash_profile');
  let content: string;
  try {
    content = fs.readFileSync(profile, 'utf8');
  } catch {
    return undefined;
  }
  if (content.includes('bashrc')) return undefined;
  return (
    `Note: ${profile} does not load ~/.bashrc, so login shells will not run the hook.\n` +
    `Add this line to ${profile}:\n  [ -f ~/.bashrc ] && . ~/.bashrc`
  );
}
