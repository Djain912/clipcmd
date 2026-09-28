/**
 * `clipcmd uninstall [shell | --all]` command
 * Removes the clipcmd shell hook from the shell's config file. `--all`
 * removes clipcmd from every shell, removes the link handler and stops the
 * daemon — run it before `npm uninstall -g clipcmd`.
 * Requirements: 2.9
 */
import { getConfigDir } from '../../config/paths';
import { resolveShellArg, SUPPORTED_SHELLS, UnsupportedShellError } from '../../installer/shellDetector';
import type { SupportedShell } from '../../installer/shellDetector';
import { getConfigPath, isInstalled, MalformedHookBlockError, uninstall } from '../../installer/installer';
import { isProtocolHandlerInstalled, unregisterProtocolHandler, urlScheme } from '../../installer/protocolHandler';
import { disallowSchemeInWindowsTerminal } from '../../installer/windowsTerminal';
import { stopDaemon } from './stop';

function removeLinkHandler(): void {
  const scheme = urlScheme();
  const had = isProtocolHandlerInstalled();
  unregisterProtocolHandler(scheme);
  if (process.platform === 'win32') disallowSchemeInWindowsTerminal(scheme);
  if (had) console.log(`Removed the ${scheme}:// link handler.`);
}

function isHooked(shell: SupportedShell): boolean {
  try {
    return isInstalled(shell);
  } catch {
    return false;
  }
}

async function uninstallAll(): Promise<number> {
  let failed = false;
  for (const shell of SUPPORTED_SHELLS) {
    if (!isHooked(shell)) continue;
    try {
      uninstall(shell);
      console.log(`Removed the ${shell} hook from ${getConfigPath(shell)}.`);
    } catch (err) {
      failed = true;
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
  removeLinkHandler();

  const stopped = await stopDaemon();
  if (stopped.status === 'stopped') console.log('Stopped the daemon.');
  if (stopped.status === 'failed') {
    failed = true;
    console.error(stopped.message);
  }

  console.log(
    `clipcmd is uninstalled; open terminals keep it until they are closed. Settings and logs remain in ${getConfigDir()}.`
  );
  return failed ? 1 : 0;
}

export async function run(args: string[]): Promise<number> {
  if (args.includes('--all')) return uninstallAll();

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

  const configFilePath = getConfigPath(shell);
  let removed: boolean;
  try {
    removed = uninstall(shell);
  } catch (err) {
    if (err instanceof MalformedHookBlockError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  if (!removed) {
    console.log(`clipcmd hook is not installed for ${shell}`);
    return 0;
  }

  console.log(
    `clipcmd hook removed from ${configFilePath}. Restart your terminal for changes to take effect.`
  );

  // The link handler is shared by all shells: remove it with the last hook
  if (!SUPPORTED_SHELLS.some(isHooked)) removeLinkHandler();
  return 0;
}
