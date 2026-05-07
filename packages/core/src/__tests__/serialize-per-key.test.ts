/**
 * serializePerKey tests
 *
 * The contract under test:
 *   - Two calls with the same key run in strict sequence.
 *   - Two calls with different keys run in parallel.
 *   - A rejected task does not poison subsequent tasks for the same key.
 *   - The chains Map is bounded by in-flight work, not by total keys seen.
 */

import { describe, it, expect } from 'vitest';
import { serializePerKey } from '../serialize-per-key';

describe('serializePerKey', () => {
  it('serializes calls with the same key', async () => {
    const chains = new Map<string, Promise<void>>();
    const trace: string[] = [];

    const task = (id: string) => async () => {
      trace.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 15));
      trace.push(`end-${id}`);
      return id;
    };

    await Promise.all([
      serializePerKey('k', chains, task('1')),
      serializePerKey('k', chains, task('2')),
      serializePerKey('k', chains, task('3')),
    ]);

    expect(trace).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  it('parallelizes calls with different keys', async () => {
    const chains = new Map<string, Promise<void>>();
    const trace: string[] = [];

    const task = (id: string) => async () => {
      trace.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 15));
      trace.push(`end-${id}`);
    };

    await Promise.all([
      serializePerKey('a', chains, task('a')),
      serializePerKey('b', chains, task('b')),
    ]);

    // Both must start before either ends — no serialization across keys
    const starts = trace.filter((t) => t.startsWith('start-'));
    const firstEndIndex = trace.findIndex((t) => t.startsWith('end-'));
    expect(starts.length).toBe(2);
    expect(firstEndIndex).toBeGreaterThan(1);
  });

  it('returns the value produced by the work function', async () => {
    const chains = new Map<string, Promise<void>>();

    const result = await serializePerKey('k', chains, async () => 42);
    expect(result).toBe(42);

    const result2 = await serializePerKey('k', chains, async () => ({ foo: 'bar' }));
    expect(result2).toEqual({ foo: 'bar' });
  });

  it('propagates errors to the caller', async () => {
    const chains = new Map<string, Promise<void>>();

    await expect(
      serializePerKey('k', chains, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('does not poison the chain when one task fails', async () => {
    const chains = new Map<string, Promise<void>>();
    let callCount = 0;

    const results = await Promise.allSettled([
      serializePerKey('k', chains, async () => {
        callCount++;
        throw new Error('first fails');
      }),
      serializePerKey('k', chains, async () => {
        callCount++;
        return 'second ok';
      }),
      serializePerKey('k', chains, async () => {
        callCount++;
        return 'third ok';
      }),
    ]);

    expect(results[0]).toEqual({ status: 'rejected', reason: expect.any(Error) });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'second ok' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'third ok' });
    expect(callCount).toBe(3);
  });

  it('clears the chain entry when the last task finishes', async () => {
    const chains = new Map<string, Promise<void>>();

    await serializePerKey('k', chains, async () => 1);
    expect(chains.has('k')).toBe(false);

    await serializePerKey('k', chains, async () => 2);
    expect(chains.has('k')).toBe(false);
  });

  it('keeps the chain entry while work is in flight', async () => {
    const chains = new Map<string, Promise<void>>();
    let release: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = serializePerKey('k', chains, async () => {
      await gate;
      return 'first';
    });

    // While first is awaiting the gate, the chain entry must exist so
    // that a second caller chains onto it.
    expect(chains.has('k')).toBe(true);

    release!();
    await first;
    expect(chains.has('k')).toBe(false);
  });

  it('chains a second call onto a pending first call for the same key', async () => {
    const chains = new Map<string, Promise<void>>();
    let release1: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const trace: string[] = [];

    const first = serializePerKey('k', chains, async () => {
      trace.push('first-start');
      await gate1;
      trace.push('first-end');
    });

    const second = serializePerKey('k', chains, async () => {
      trace.push('second-start');
      trace.push('second-end');
    });

    // Second must not start until first resolves the gate
    await new Promise((r) => setTimeout(r, 10));
    expect(trace).toEqual(['first-start']);

    release1!();
    await Promise.all([first, second]);
    expect(trace).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('supports non-string keys', async () => {
    type Key = { id: number };
    const chains = new Map<Key, Promise<void>>();
    const k1: Key = { id: 1 };
    const k2: Key = { id: 2 };

    const results = await Promise.all([
      serializePerKey(k1, chains, async () => 'one'),
      serializePerKey(k2, chains, async () => 'two'),
    ]);

    expect(results).toEqual(['one', 'two']);
  });
});
