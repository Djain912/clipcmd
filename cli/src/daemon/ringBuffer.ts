/**
 * Block represents a single shell command execution record.
 */
export interface Block {
  id: string;          // UUID v4
  command: string;     // Decoded command string
  pwd: string;         // Working directory
  timestamp: number;   // Unix ms
  exitCode: number | null;
  output: string;      // Raw captured bytes (ANSI preserved)
  inProgress: boolean;
  sessionId?: string;  // Shell session that ran it (hook `sid`)
  term?: string;       // Terminal reported by the hook, e.g. 'vscode'
  seq?: number;        // Hook's per-session command counter (matches /output)
  outputFromClient?: boolean; // Output was supplied via /output (clipcmd shell, VS Code)
}

/**
 * RingBuffer is a fixed-capacity circular buffer of Blocks.
 * When full, pushing a new Block evicts the oldest one (FIFO eviction).
 */
export class RingBuffer {
  private readonly _capacity: number;
  private readonly _slots: (Block | null)[];
  private _head: number; // index of the next slot to write into
  private _size: number;

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be at least 1, got ${capacity}`);
    }
    this._capacity = capacity;
    this._slots = new Array<Block | null>(capacity).fill(null);
    this._head = 0;
    this._size = 0;
  }

  /**
   * Pushes a Block into the buffer.
   * Returns the evicted Block if the buffer was full, otherwise null.
   */
  push(block: Block): Block | null {
    const evicted = this._slots[this._head];

    this._slots[this._head] = block;
    this._head = (this._head + 1) % this._capacity;

    if (this._size < this._capacity) {
      this._size++;
      return null;
    }

    // Buffer was already full — evicted is the block we just overwrote
    return evicted;
  }

  /**
   * Returns the Block with the given id, or undefined if not found.
   */
  get(id: string): Block | undefined {
    for (const slot of this._slots) {
      if (slot !== null && slot.id === id) {
        return slot;
      }
    }
    return undefined;
  }

  /**
   * Returns all Blocks in insertion (chronological) order, oldest first.
   */
  getAll(): Block[] {
    if (this._size === 0) return [];

    const result: Block[] = [];

    if (this._size < this._capacity) {
      // Buffer is not yet full: valid entries are at indices 0..(size-1),
      // in insertion order (head hasn't wrapped past filled slots yet).
      for (let i = 0; i < this._size; i++) {
        result.push(this._slots[i] as Block);
      }
    } else {
      // Buffer is full: oldest entry is at _head, wrapping around.
      for (let i = 0; i < this._capacity; i++) {
        const slot = this._slots[(this._head + i) % this._capacity];
        if (slot !== null) {
          result.push(slot);
        }
      }
    }

    return result;
  }

  /** The maximum number of Blocks the buffer can hold. */
  get capacity(): number {
    return this._capacity;
  }

  /** The current number of Blocks stored in the buffer. */
  get size(): number {
    return this._size;
  }
}
