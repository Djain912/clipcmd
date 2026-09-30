/**
 * MultiSelectQueue maintains an ordered list of Block IDs that the user
 * has toggled for batch copying.
 */
export class MultiSelectQueue {
  private _ids: string[] = [];

  /**
   * Toggles a Block ID in the queue.
   * If the ID is absent it is appended to the end.
   * If the ID is already present it is removed.
   */
  toggle(id: string): void {
    const index = this._ids.indexOf(id);
    if (index === -1) {
      this._ids.push(id);
    } else {
      this._ids.splice(index, 1);
    }
  }

  /**
   * Returns a shallow ordered copy of all IDs currently in the queue.
   */
  getAll(): string[] {
    return [...this._ids];
  }

  /**
   * Removes a specific ID from the queue.
   * Used when a Block is evicted from the Ring_Buffer.
   * No-op if the ID is not present.
   */
  remove(id: string): void {
    const index = this._ids.indexOf(id);
    if (index !== -1) {
      this._ids.splice(index, 1);
    }
  }

  /**
   * Empties the queue.
   * Called after a successful /copy-selected operation.
   */
  clear(): void {
    this._ids = [];
  }

  /**
   * Returns true if the given ID is currently in the queue.
   */
  has(id: string): boolean {
    return this._ids.includes(id);
  }

  /** The current number of IDs in the queue. */
  get size(): number {
    return this._ids.length;
  }
}
