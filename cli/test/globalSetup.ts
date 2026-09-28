import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FAKE_LOCALAPPDATA, TEST_URL_SCHEME } from '../vitest.config';

/** Compile src/ to dist/ so end-to-end tests exercise the shipped JavaScript. */
export default function setup(): () => void {
  const root = path.resolve(__dirname, '..');
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', root], {
    cwd: root,
    stdio: 'inherit',
  });
  fs.mkdirSync(FAKE_LOCALAPPDATA, { recursive: true });

  return () => {
    // Remove whatever the tests registered under the throwaway scheme
    if (process.platform === 'win32') {
      spawnSync('reg.exe', ['delete', `HKCU\\Software\\Classes\\${TEST_URL_SCHEME}`, '/f'], { windowsHide: true });
    }
    fs.rmSync(FAKE_LOCALAPPDATA, { recursive: true, force: true });
  };
}
