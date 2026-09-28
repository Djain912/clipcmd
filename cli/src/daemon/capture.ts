import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../config/config';
import { getSessionsDir } from '../config/paths';

/**
 * CaptureSource interface for output capture implementations.
 */
export interface CaptureSource {
  startCapture(blockId: string, sessionId: string): void;
  /** Returns the raw output produced since startCapture for this block. */
  endCapture(blockId: string): string | Promise<string>;
  /** True if output is being captured for this session (e.g. it runs inside `clipcmd shell`). */
  isCapturing?(sessionId: string): boolean;
}

/**
 * Session ids come from the shell hooks (`CLIPCMD_SESSION` or the shell pid)
 * and become file names, so they are restricted to a safe character set to
 * rule out path traversal (`../`) and odd file names.
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(id) && id !== '.' && id !== '..';
}

export interface FileTailCaptureOptions {
  /** Directory holding `{sessionId}.log` files. Defaults to ~/.config/clipcmd/sessions. */
  sessionsDir?: () => string;
  /** Keep at most this many trailing bytes of output per block. */
  maxBytes?: number;
  /** How long the file must stop growing before output is considered complete. */
  settleMs?: number;
  /** Upper bound on the settle wait, so a chatty background job cannot stall /end. */
  maxWaitMs?: number;
}

/**
 * FileTailCapture reads the bytes appended to a session's capture file between
 * startCapture and endCapture.
 *
 * Each shell session writes to its own `sessions/{sessionId}.log` (the
 * `clipcmd shell` PTY wrapper does this), so concurrent terminals never mix
 * output. When a session has no capture file, captured output is empty.
 */
export class FileTailCapture implements CaptureSource {
  private readonly pending = new Map<string, { file: string; offset: number }>();
  private readonly sessionsDir: () => string;
  private readonly maxBytes: number;
  private readonly settleMs: number;
  private readonly maxWaitMs: number;

  constructor(options: FileTailCaptureOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? getSessionsDir;
    this.maxBytes = options.maxBytes ?? DEFAULT_CONFIG.maxOutputBytes;
    this.settleMs = options.settleMs ?? 20;
    this.maxWaitMs = options.maxWaitMs ?? 150;
  }

  /** Path of the capture file for a session. */
  fileFor(sessionId: string): string {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
    }
    return path.join(this.sessionsDir(), `${sessionId}.log`);
  }

  /** A session is captured when its capture file exists (written by `clipcmd shell`). */
  isCapturing(sessionId: string): boolean {
    return isValidSessionId(sessionId) && fileSize(this.fileFor(sessionId)) !== undefined;
  }

  /**
   * Record the current byte offset (file size) of the session's capture file.
   * If the file does not exist, records offset 0.
   */
  startCapture(blockId: string, sessionId: string): void {
    const file = this.fileFor(sessionId);
    this.pending.set(blockId, { file, offset: fileSize(file) ?? 0 });
  }

  /**
   * Read bytes from the recorded offset to the current end of file, decoded as
   * UTF-8 with every byte otherwise preserved (ANSI codes, \r, \t, ...).
   * Returns '' if the block is unknown or the capture file is missing.
   */
  async endCapture(blockId: string): Promise<string> {
    const entry = this.pending.get(blockId);
    this.pending.delete(blockId);
    if (!entry) return '';

    if (fileSize(entry.file) === undefined) return '';
    const size = await this.waitForQuiet(entry.file);

    // A smaller file means it was truncated or rotated mid-command: read it all.
    let start = size < entry.offset ? 0 : entry.offset;
    if (size - start > this.maxBytes) {
      start = size - this.maxBytes;
    }
    const length = size - start;
    if (length <= 0) return '';

    let fd: number | undefined;
    try {
      fd = fs.openSync(entry.file, 'r');
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, start);
      let bytes = buffer.subarray(0, bytesRead);
      if (start > entry.offset) {
        // Output was cut to maxBytes; skip a partial UTF-8 sequence at the cut.
        let skip = 0;
        while (skip < bytes.length && skip < 3 && (bytes[skip] & 0xc0) === 0x80) skip++;
        bytes = bytes.subarray(skip);
      }
      return bytes.toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * The writer (PTY wrapper) appends asynchronously, so the command's last
   * bytes can land just after the shell reports completion. Wait until the
   * file size is stable for settleMs (bounded by maxWaitMs).
   */
  private async waitForQuiet(file: string): Promise<number> {
    const deadline = Date.now() + this.maxWaitMs;
    let size = fileSize(file) ?? 0;
    while (this.settleMs > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      const next = fileSize(file) ?? 0;
      if (next === size) break;
      size = next;
    }
    return size;
  }
}

function fileSize(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}
