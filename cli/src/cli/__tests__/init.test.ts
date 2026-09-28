import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir } from '../../../test/helpers';

const info = vi.hoisted(() => ({ profile: '', executionPolicy: undefined as string | undefined }));
vi.mock('../../installer/powershell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../installer/powershell')>()),
  getPowerShellInfo: () => info,
}));

import { loginShellWarning, run } from '../commands/init';

describe('clipcmd init powershell', () => {
  let home: string;

  beforeEach(() => {
    home = makeTempDir();
    info.profile = path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  });
  afterEach(() => {
    removeDir(home);
    vi.restoreAllMocks();
  });

  it.each(['Restricted', 'AllSigned'])(
    'refuses when the execution policy (%s) would block the profile, without touching it',
    async (policy) => {
      info.executionPolicy = policy;
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await run(['powershell'])).toBe(1);
      expect(err.mock.calls[0][0]).toContain(`execution policy is ${policy}`);
      expect(err.mock.calls[0][0]).toContain('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
      expect(fs.existsSync(info.profile)).toBe(false);
    }
  );

  it.each(['RemoteSigned', 'Unrestricted', 'Bypass', undefined])('installs under policy %s', async (policy) => {
    info.executionPolicy = policy;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['pwsh'])).toBe(0);
    expect(fs.readFileSync(info.profile, 'utf8')).toContain('PSConsoleHostReadLine');
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('. $PROFILE');
  });
});

describe('loginShellWarning', () => {
  let home: string;
  beforeEach(() => (home = makeTempDir()));
  afterEach(() => removeDir(home));

  it('only warns when ~/.bash_profile exists without loading ~/.bashrc', () => {
    expect(loginShellWarning(home)).toBeUndefined();
    fs.writeFileSync(path.join(home, '.bash_profile'), 'export X=1\n');
    expect(loginShellWarning(home)).toContain('does not load ~/.bashrc');
    fs.writeFileSync(path.join(home, '.bash_profile'), 'source ~/.bashrc\n');
    expect(loginShellWarning(home)).toBeUndefined();
  });
});
