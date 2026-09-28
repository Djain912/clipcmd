import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MultiSelectQueue } from '../multiSelectQueue';

describe('MultiSelectQueue', () => {
  it('toggles ids in and out while keeping order', () => {
    const queue = new MultiSelectQueue();
    queue.toggle('a');
    queue.toggle('b');
    queue.toggle('c');
    queue.toggle('b');
    expect(queue.getAll()).toEqual(['a', 'c']);
    expect(queue.has('b')).toBe(false);
    expect(queue.size).toBe(2);
  });

  it('remove() and clear() are safe on missing ids and empty queues', () => {
    const queue = new MultiSelectQueue();
    queue.remove('nope');
    queue.clear();
    queue.toggle('a');
    queue.remove('a');
    expect(queue.size).toBe(0);
  });

  it('getAll() returns a copy', () => {
    const queue = new MultiSelectQueue();
    queue.toggle('a');
    queue.getAll().push('mutated');
    expect(queue.getAll()).toEqual(['a']);
  });

  // Feature: clipcmd, Property 3: Multi_Select_Queue toggle idempotence
  it('toggling an id twice restores the previous queue (Property 3)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string()), fc.string(), (initial, id) => {
        const queue = new MultiSelectQueue();
        initial.forEach((x) => queue.toggle(x));
        const before = queue.getAll();
        queue.toggle(id);
        queue.toggle(id);
        // Toggling an existing id removes then re-appends it at the end
        const expected = before.includes(id) ? [...before.filter((x) => x !== id), id] : before;
        expect(queue.getAll()).toEqual(expected);
      })
    );
  });

  // Feature: clipcmd, Property 4: Multi_Select_Queue uniqueness invariant
  it('never contains duplicates (Property 4)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'c', 'd')), (ops) => {
        const queue = new MultiSelectQueue();
        ops.forEach((id) => queue.toggle(id));
        const all = queue.getAll();
        expect(new Set(all).size).toBe(all.length);
      })
    );
  });
});
