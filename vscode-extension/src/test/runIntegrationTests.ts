import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Launches a real VS Code with this extension under development and runs
 * out/test/integration inside its extension host.
 *
 * - VSCODE_EXECUTABLE_PATH: use an installed VS Code instead of downloading one
 * - VSCODE_TEST_VERSION: download a specific version (default: latest stable).
 *   The in-host runner uses mocha 12, which needs VS Code 1.101+ (Node 22).
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './integration/index');
  // Isolate the extension from any real daemon: tests write their own port file here
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcmd-vscode-it-'));

  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
      version: process.env.VSCODE_TEST_VERSION || undefined,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions'],
      extensionTestsEnv: { CLIPCMD_CONFIG_DIR: configDir },
    });
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error('Integration tests failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
