/**
 * `clipcmd open <url>` command
 * What the Linux and macOS link handlers run when a copy button is clicked:
 * forwards clipcmd://copy?id=..&type=.. (or select / copy-selected) to the
 * daemon. Silent by design; the exit code says whether it worked.
 */
import { readPortFile } from '../../config/portFile';
import { parseButtonUrl } from '../../installer/protocolHandler';
import { httpGet } from '../../shared/daemonClient';

export async function run(args: string[]): Promise<number> {
  const target = parseButtonUrl(args[0] ?? '');
  if (!target) {
    console.error('Usage: clipcmd open clipcmd://copy?id=<id>&type=cmd|output|both');
    return 2;
  }
  const info = readPortFile();
  if (!info) return 1;
  try {
    const { status } = await httpGet(info.port, `/${target.action}${target.query ? `?${target.query}` : ''}`, 5000);
    return status === 200 ? 0 : 1;
  } catch {
    return 1;
  }
}
