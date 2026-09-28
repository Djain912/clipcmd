import * as os from 'node:os'
import * as path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Tests must never touch the user's real Windows setup: `clipcmd init`
 * registers a URL scheme under HKCU and edits Windows Terminal's settings in
 * %LOCALAPPDATA%. Every test process (and every CLI it spawns) gets a
 * throwaway scheme name and an empty LOCALAPPDATA; globalSetup removes the
 * throwaway registration afterwards. test/e2e/isolation.test.ts checks this.
 */
export const TEST_URL_SCHEME = 'clipcmd-vitest'
export const FAKE_LOCALAPPDATA = path.join(os.tmpdir(), 'clipcmd-vitest-localappdata')

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
      LOCALAPPDATA: FAKE_LOCALAPPDATA,
      // Still needed to find the installed VS Code's shell-integration scripts
      CLIPCMD_TEST_REAL_LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    },
  },
})
