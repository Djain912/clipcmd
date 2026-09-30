import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Block, RingBuffer } from '../ringBuffer';

function block(id: string): Block {
  return { id, command: `cmd-${id}`, pwd: '/', timestamp: 0, exitCode: 0, output: '', inProgress: false };
}

describe('RingBuffer', () => {
  it('rejects capacities below 1', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-3)).toThrow(RangeError);
  });

  it('returns undefined for unknown ids and null eviction while filling', () => {
    const buffer = new RingBuffer(3);
    expect(buffer.get('missing')).toBeUndefined();
    expect(buffer.push(block('a'))).toBeNull();
    expect(buffer.push(block('b'))).toBeNull();
    expect(buffer.size).toBe(2);
    expect(buffer.get('a')?.command).toBe('cmd-a');
  });

  it('returns blocks in insertion order before and after wrap-around', () => {
    const buffer = new RingBuffer(3);
    ['a', 'b'].forEach((id) => buffer.push(block(id)));
    expect(buffer.getAll().map((b) => b.id)).toEqual(['a', 'b']);
    ['c', 'd', 'e'].forEach((id) => buffer.push(block(id)));
    expect(buffer.getAll().map((b) => b.id)).toEqual(['c', 'd', 'e']);
    expect(buffer.get('a')).toBeUndefined();
  });

  it('works with capacity 1', () => {
    const buffer = new RingBuffer(1);
    expect(buffer.push(block('a'))).toBeNull();
    expect(buffer.push(block('b'))?.id).toBe('a');
    expect(buffer.getAll().map((b) => b.id)).toEqual(['b']);
  });

  it('never holds more than its capacity', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 500 }), (capacity, count) => {
        const buffer = new RingBuffer(capacity);
        for (let i = 0; i < count; i++) {
          buffer.push(block(String(i)));
          expect(buffer.size).toBeLessThanOrEqual(buffer.capacity);
        }
        expect(buffer.size).toBe(Math.min(capacity, count));
      })
    );
  });

  it('always evicts the oldest block', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 200 }), (capacity, extra) => {
        const buffer = new RingBuffer(capacity);
        for (let i = 0; i < capacity; i++) buffer.push(block(String(i)));
        for (let i = capacity; i < capacity + extra; i++) {
          const evicted = buffer.push(block(String(i)));
          expect(evicted?.id).toBe(String(i - capacity));
          const all = buffer.getAll();
          expect(all[all.length - 1].id).toBe(String(i));
          expect(all[0].id).toBe(String(i - capacity + 1));
        }
      })
    );
  });
});
