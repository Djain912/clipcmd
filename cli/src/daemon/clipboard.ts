/**
 * ClipboardWriter — thin wrapper around clipboardy.
 *
 * clipboardy v4 is ESM-only. tsconfig uses `module: Node16`, which keeps this
 * `import()` as a real dynamic import in the CommonJS output; with
 * `module: CommonJS` TypeScript rewrites it to `require()`, which throws
 * ERR_REQUIRE_ESM on Node 18/20.
 */

export class ClipboardError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = 'ClipboardError';
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ClipboardWriter {
  write(text: string): Promise<void>;
}

export class ClipboardWriterImpl implements ClipboardWriter {
  async write(text: string): Promise<void> {
    try {
      const { default: clipboard } = await import('clipboardy');
      await clipboard.write(text);
    } catch (err) {
      throw new ClipboardError(
        `Failed to write to clipboard: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
}
