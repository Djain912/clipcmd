import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The clipcmd VS Code extension. In VS Code's terminal it captures each
 * command's output; without it, VS Code shows only [COPY CMD] and [+].
 */
export const EXTENSION_ID = 'djain912.clipcmd';
export const EXTENSION_URL = `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`;
export const EXTENSION_INSTALL = `code --install-extension ${EXTENSION_ID}`;

export interface VscodeStatus {
  /** VS Code (stable or Insiders) has run for this user. */
  installed: boolean;
  /** The clipcmd extension is installed in it. */
  extension: boolean;
}

/**
 * VS Code keeps its user data in ~/.vscode (Insiders: ~/.vscode-insiders),
 * created on first start, with one folder per installed extension.
 */
export function getVscodeStatus(home: string = os.homedir()): VscodeStatus {
  const status: VscodeStatus = { installed: false, extension: false };
  for (const dir of ['.vscode', '.vscode-insiders']) {
    const root = path.join(home, dir);
    if (!fs.existsSync(path.join(root, 'extensions'))) continue;
    status.installed = true;
    try {
      if (fs.readdirSync(path.join(root, 'extensions')).some((name) => name.toLowerCase().startsWith(`${EXTENSION_ID}-`))) {
        status.extension = true;
      }
    } catch {
      // unreadable: treated as not installed
    }
  }
  return status;
}
