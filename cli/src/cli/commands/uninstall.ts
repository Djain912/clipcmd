/**
 * `clipcmd uninstall [shell]` command
 * Removes the clipcmd shell hook from the shell's config file.
 * Requirements: 2.9
 */
import { resolveShellArg, SUPPORTED_SHELLS, UnsupportedShellError } from '../../installer/shellDetector';
import type { SupportedShell } from '../../installer/shellDetector';
import { getConfigPath, isInstalled, MalformedHookBlockError, uninstall } from '../../installer/installer';
import { unregisterProtocolHandler, urlScheme } from '../../installer/protocolHandler';
import { disallowSchemeInWindowsTerminal } from '../../installer/windowsTerminal';

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

  // The clipcmd:// handler is shared by all shells: remove it with the last hook
  if (process.platform === 'win32' && !SUPPORTED_SHELLS.some((s) => isInstalled(s))) {
    const scheme = urlScheme();
    unregisterProtocolHandler(scheme);
    disallowSchemeInWindowsTerminal(scheme);
    console.log(`Removed the ${scheme}:// link handler.`);
  }
  return 0;
}
