import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FAKE_CONFIG_DIR,
  FAKE_LOCALAPPDATA,
  FAKE_POWERSHELL_PROFILE,
  FAKE_XDG_DATA_HOME,
  TEST_URL_SCHEME,
} from '../vitest.config';

const FAKE_DIRS = [FAKE_LOCALAPPDATA, FAKE_XDG_DATA_HOME, FAKE_CONFIG_DIR, path.dirname(FAKE_POWERSHELL_PROFILE)];

/** Compile src/ to dist/ so end-to-end tests exercise the shipped JavaScript. */
export default function setup(): () => void {
  const root = path.resolve(__dirname, '..');
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', root], {
    cwd: root,
    stdio: 'inherit',
  });
  for (const dir of FAKE_DIRS) fs.mkdirSync(dir, { recursive: true });

  return () => {
    // Remove whatever the tests registered under the throwaway scheme
    if (process.platform === 'win32') {
      spawnSync('reg.exe', ['delete', `HKCU\\Software\\Classes\\${TEST_URL_SCHEME}`, '/f'], { windowsHide: true });
    }
    for (const dir of FAKE_DIRS) fs.rmSync(dir, { recursive: true, force: true });
  };
}
