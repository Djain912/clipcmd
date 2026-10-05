import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getVscodeStatus } from '../vscode';
import { makeTempDir, removeDir } from '../../../test/helpers';

describe('getVscodeStatus', () => {
  let home: string;
  beforeEach(() => {
    home = makeTempDir();
  });
  afterEach(() => removeDir(home));

  const extensions = (dir = '.vscode') => {
    const p = path.join(home, dir, 'extensions');
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  it('no VS Code', () => {
    expect(getVscodeStatus(home)).toEqual({ installed: false, extension: false });
  });

  it('VS Code without the extension', () => {
    fs.mkdirSync(path.join(extensions(), 'ms-python.python-2026.1.0'));
    expect(getVscodeStatus(home)).toEqual({ installed: true, extension: false });
  });

  it('VS Code with the extension, in any version and letter case', () => {
    fs.mkdirSync(path.join(extensions(), 'Djain912.clipcmd-0.0.2'));
    expect(getVscodeStatus(home)).toEqual({ installed: true, extension: true });
  });

  it('VS Code Insiders counts too', () => {
    fs.mkdirSync(path.join(extensions('.vscode-insiders'), 'djain912.clipcmd-0.0.1'));
    expect(getVscodeStatus(home)).toEqual({ installed: true, extension: true });
  });

  it('another extension whose name starts the same is not clipcmd', () => {
    fs.mkdirSync(path.join(extensions(), 'djain912.clipcmdx-1.0.0'));
    expect(getVscodeStatus(home).extension).toBe(false);
  });
});
