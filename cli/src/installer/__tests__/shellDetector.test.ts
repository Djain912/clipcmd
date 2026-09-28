import { afterEach, describe, expect, it } from 'vitest';
import {
  DefaultShellDetector,
  parseShell,
  pickShellFromAncestors,
  resolveShellArg,
  UnsupportedShellError,
} from '../shellDetector';

describe('shell detection', () => {
  const saved = process.env.SHELL;
  afterEach(() => {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  });

  it.each([
    ['/bin/zsh', 'zsh'],
    ['/usr/bin/bash', 'bash'],
    ['/usr/local/bin/fish', 'fish'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'],
    ['/opt/homebrew/bin/ZSH', 'zsh'],
    ['bash', 'bash'],
    ['/usr/local/bin/pwsh', 'pwsh'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh'],
    ['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell'],
    ['PowerShell', 'powershell'],
  ])('maps %s to %s', (value, expected) => {
    expect(parseShell(value)).toBe(expected);
    process.env.SHELL = value;
    expect(new DefaultShellDetector('linux').detect()).toBe(expected);
  });

  it.each(['/bin/sh', '/bin/tcsh', 'cmd.exe', '/usr/bin/zsh-5.9', 'powershell_ise.exe'])(
    'rejects unsupported shell %s',
    (value) => {
      process.env.SHELL = value;
      expect(() => new DefaultShellDetector('linux').detect()).toThrow(UnsupportedShellError);
    }
  );

  it('explains how to proceed when the shell cannot be detected', () => {
    delete process.env.SHELL;
    expect(() => new DefaultShellDetector('linux').detect()).toThrow(/Could not detect your shell.*clipcmd init powershell/);
  });

  it('prefers an explicit shell argument over SHELL', () => {
    process.env.SHELL = '/bin/zsh';
    expect(resolveShellArg(['fish'])).toBe('fish');
    expect(resolveShellArg(['pwsh'])).toBe('pwsh');
    expect(resolveShellArg([])).toBe('zsh');
    expect(() => resolveShellArg(['cmd'])).toThrow(/Supported shells: zsh, bash, fish, powershell, pwsh.*use PowerShell/);
  });

  describe('Windows (PowerShell sets no SHELL)', () => {
    it('detects the PowerShell it was started from', () => {
      delete process.env.SHELL;
      const detector = new DefaultShellDetector('win32', () => ['cmd.exe', 'powershell.exe', 'WindowsTerminal.exe']);
      expect(detector.detect()).toBe('powershell');
      expect(new DefaultShellDetector('win32', () => ['pwsh.exe', 'Code.exe']).detect()).toBe('pwsh');
    });

    it('reports cmd.exe as unsupported', () => {
      delete process.env.SHELL;
      const detector = new DefaultShellDetector('win32', () => ['cmd.exe', 'cmd.exe', 'explorer.exe']);
      expect(() => detector.detect()).toThrow(/cmd\.exe.*use PowerShell/);
    });

    it('still uses SHELL when set (Git Bash)', () => {
      process.env.SHELL = '/usr/bin/bash';
      expect(new DefaultShellDetector('win32', () => ['powershell.exe']).detect()).toBe('bash');
    });
  });

  it.each([
    [['powershell.exe'], 'powershell'],
    [['cmd.exe', 'powershell.exe'], 'powershell'], // npm's clipcmd.cmd shim
    [['node.exe', 'cmd.exe', 'pwsh.exe'], 'pwsh'],
    [['cmd.exe', 'cmd.exe', 'powershell.exe'], undefined], // really inside cmd
    [['bash.exe', 'powershell.exe'], 'bash'],
    [['explorer.exe'], undefined],
    [[], undefined],
  ])('pickShellFromAncestors(%j) → %s', (names, expected) => {
    expect(pickShellFromAncestors(names)).toBe(expected);
  });
});
