import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { buildButtonsString, buildOsc8Button, linkFor, printButtons } from '../osc8';
import type { Block } from '../ringBuffer';

const block: Block = {
  id: '4f1c1d9e-0000-4000-8000-000000000001',
  command: 'ls',
  pwd: '/',
  timestamp: 0,
  exitCode: 0,
  output: '',
  inProgress: false,
};

/** [label, url] pairs of every OSC 8 link in a button line. */
function links(line: string): string[][] {
  return [...line.matchAll(/\x1b\]8;;([^\x07]+)\x07([^\x1b]+)\x1b\]8;;\x07/g)].map((m) => [m[2], m[1]]);
}

describe('OSC 8 buttons', () => {
  const savedScheme = process.env.CLIPCMD_URL_SCHEME;
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedScheme === undefined) delete process.env.CLIPCMD_URL_SCHEME;
    else process.env.CLIPCMD_URL_SCHEME = savedScheme;
  });

  // Feature: clipcmd, Property 11: OSC 8 button format correctness
  it('builds exactly \\x1b]8;;{url}\\x07{label}\\x1b]8;;\\x07 (Property 11)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (label, url) => {
        expect(buildOsc8Button(label, url)).toBe(`\x1b]8;;${url}\x07${label}\x1b]8;;\x07`);
      })
    );
  });

  it('builds four buttons on one line targeting the right endpoints (http links)', () => {
    const line = buildButtonsString(block, 9666);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(links(line)).toEqual([
      ['[COPY CMD]', `http://127.0.0.1:9666/copy?id=${block.id}&type=cmd`],
      ['[COPY OUTPUT]', `http://127.0.0.1:9666/copy?id=${block.id}&type=output`],
      ['[COPY BOTH]', `http://127.0.0.1:9666/copy?id=${block.id}&type=both`],
      ['[+]', `http://127.0.0.1:9666/select?id=${block.id}`],
    ]);
  });

  it('uses clipcmd:// links when the protocol handler is in use', () => {
    delete process.env.CLIPCMD_URL_SCHEME; // the suite runs with a throwaway scheme
    expect(links(buildButtonsString(block, 9666, { scheme: 'clipcmd' }))).toEqual([
      ['[COPY CMD]', `clipcmd://copy?id=${block.id}&type=cmd`],
      ['[COPY OUTPUT]', `clipcmd://copy?id=${block.id}&type=output`],
      ['[COPY BOTH]', `clipcmd://copy?id=${block.id}&type=both`],
      ['[+]', `clipcmd://select?id=${block.id}`],
    ]);
    process.env.CLIPCMD_URL_SCHEME = 'clipcmd-test';
    expect(linkFor('select', 'id=x', 1, 'clipcmd')).toBe('clipcmd-test://select?id=x');
  });

  it('leaves out the output buttons when no output is captured', () => {
    expect(links(buildButtonsString(block, 1, { withOutput: false })).map(([label]) => label)).toEqual([
      '[COPY CMD]',
      '[+]',
    ]);
  });

  it('printButtons writes the same string to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printButtons(block, 1234);
    expect(spy).toHaveBeenCalledWith(buildButtonsString(block, 1234));
  });
});
