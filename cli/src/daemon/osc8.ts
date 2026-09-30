import { Block } from './ringBuffer';
import { urlScheme } from '../installer/protocolHandler';

/**
 * Builds an OSC 8 hyperlink button string.
 *
 * Format: \x1b]8;;{url}\x07{label}\x1b]8;;\x07
 */
export function buildOsc8Button(label: string, url: string): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

/**
 * How button links are opened:
 * - 'clipcmd': `clipcmd://...` links, handled by the small protocol handler
 *   that `clipcmd init` registers, so a click copies silently.
 * - 'http': `http://127.0.0.1:{port}/...` links, opened by the browser (used
 *   where no protocol handler is registered).
 */
export type LinkScheme = 'clipcmd' | 'http';

export interface ButtonOptions {
  scheme?: LinkScheme;
  /** Output was (or will be) captured, so the output buttons are useful. */
  withOutput?: boolean;
  /**
   * Replaces a button's link, e.g. with a Windows shortcut. `button`
   * is cmd, output, both or select.
   */
  wrap?: (button: string, url: string) => string;
}

/** URL for a daemon action, e.g. linkFor('copy', 'id=..&type=cmd', ...). */
export function linkFor(action: string, query: string, port: number, scheme: LinkScheme): string {
  return scheme === 'clipcmd' ? `${urlScheme()}://${action}?${query}` : `http://127.0.0.1:${port}/${action}?${query}`;
}

/**
 * Builds the button line for a block (without printing). Returned so callers
 * can write it wherever needed (HTTP response body, stderr, a file, etc.).
 *
 * http URLs use 127.0.0.1 rather than localhost because the daemon only
 * listens on the IPv4 loopback address, and `localhost` may resolve to ::1.
 */
export function buildButtonsString(block: Block, port: number, options: ButtonOptions = {}): string {
  const scheme = options.scheme ?? 'http';
  const withOutput = options.withOutput ?? true;
  const wrap = options.wrap ?? ((_button: string, url: string) => url);
  const id = encodeURIComponent(block.id);
  const copy = (type: string) => wrap(type, linkFor('copy', `id=${id}&type=${type}`, port, scheme));

  const buttons = [buildOsc8Button('[COPY CMD]', copy('cmd'))];
  if (withOutput) {
    buttons.push(buildOsc8Button('[COPY OUTPUT]', copy('output')));
    buttons.push(buildOsc8Button('[COPY BOTH]', copy('both')));
  }
  buttons.push(buildOsc8Button('[+]', wrap('select', linkFor('select', `id=${id}`, port, scheme))));

  return `${buttons.join(' ')}\n`;
}

/**
 * Prints the buttons to stderr on one line.
 * NOTE: Only useful when the daemon has an attached stderr (e.g. foreground mode).
 * In detached daemon mode, use buildButtonsString() and return via HTTP response.
 */
export function printButtons(block: Block, port: number, options?: ButtonOptions): void {
  process.stderr.write(buildButtonsString(block, port, options));
}
