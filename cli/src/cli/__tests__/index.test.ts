import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index';

describe('cli main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the usage text for --help', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = await main(['--help']);

    expect(exitCode).toBe(0);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: clipcmd <command>'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('init'));
  });

  it.each([[[]], [['-h']], [['help']]])('prints usage for %j', async (argv) => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await main(argv)).toBe(0);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: clipcmd <command>'));
  });

  it('prints the package version for --version', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { version } = require('../../../package.json') as { version: string };

    expect(await main(['--version'])).toBe(0);
    expect(writeSpy).toHaveBeenCalledWith(`${version}\n`);
  });

  it('rejects unknown commands with exit code 1 and usage on stderr', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await main(['frobnicate'])).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command: frobnicate'));
  });
});
