import * as os from 'node:os'
import * as path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Tests must never touch the user's real setup: `clipcmd init` registers a URL
 * scheme (HKCU on Windows, a .desktop file on Linux, an app on macOS) and
 * edits Windows Terminal's settings in %LOCALAPPDATA%, and the shell hooks
 * start daemons and wrap themselves in `clipcmd shell`. Every test process
 * (and everything it spawns) gets a throwaway scheme name, empty data
 * directories and a scratch config directory, with hook auto-start and
 * auto-shell off; globalSetup removes the throwaway registration afterwards.
 * test/e2e/isolation.test.ts checks this.
 */
export const TEST_URL_SCHEME = 'clipcmd-vitest'
export const FAKE_LOCALAPPDATA = path.join(os.tmpdir(), 'clipcmd-vitest-localappdata')
export const FAKE_XDG_DATA_HOME = path.join(os.tmpdir(), 'clipcmd-vitest-xdg-data')
export const FAKE_CONFIG_DIR = path.join(os.tmpdir(), 'clipcmd-vitest-config')
export const FAKE_POWERSHELL_PROFILE = path.join(os.tmpdir(), 'clipcmd-vitest-profile', 'profile.ps1')

export default defineConfig({
  test: {
    include: ['src/**/__tests__/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // Builds dist/ once: the end-to-end tests run the real bin/clipcmd.js
    globalSetup: './test/globalSetup.ts',
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      CLIPCMD_URL_SCHEME: TEST_URL_SCHEME,
      CLIPCMD_CONFIG_DIR: FAKE_CONFIG_DIR,
      CLIPCMD_AUTOSTART: '0',
      CLIPCMD_AUTOSHELL: '0',
      // `uninstall --all` and `doctor` look at every shell, PowerShell included
      CLIPCMD_POWERSHELL_PROFILE: FAKE_POWERSHELL_PROFILE,
      LOCALAPPDATA: FAKE_LOCALAPPDATA,
      XDG_DATA_HOME: FAKE_XDG_DATA_HOME,
      // Still needed to find the installed VS Code's shell-integration scripts
      CLIPCMD_TEST_REAL_LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    },
  },
})
