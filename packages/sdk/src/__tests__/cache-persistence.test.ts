/**
 * B17 (LOCAL-STORAGE W1) — the persister hook on the cache primitive.
 *
 * Contract under test:
 *  - load-on-construct: rehydrated entries are visible synchronously and an
 *    observe() of a rehydrated key issues NO fetch (the protocol-silence pin).
 *  - save-on-mutation: debounced (default 50 ms); bursts coalesce to one save.
 *  - external change (cross-context): replaces the store; observers see it.
 *  - dispose: flushes a pending save synchronously, then goes inert (B16) —
 *    no save and no external-change application after disposal.
 *  - B15 interaction: failure markers are never persisted — a key that
 *    exhausts its retries mutates nothing, so nothing is saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom, filter, take } from 'rxjs';
import { createCache, type CachePersister } from '../cache';

function spyPersister<K, V>(initial: Map<K, V> | null = null) {
  const external: Array<(entries: Map<K, V>) => void> = [];
  const persister: CachePersister<K, V> = {
    load: vi.fn(() => initial),
    save: vi.fn(),
    subscribe: vi.fn((onExternalChange: (entries: Map<K, V>) => void) => {
      external.push(onExternalChange);
      return () => {
        const i = external.indexOf(onExternalChange);
        if (i >= 0) external.splice(i, 1);
      };
    }),
  };
  return { persister, pushExternal: (entries: Map<K, V>) => external.forEach((h) => h(entries)) };
}

describe('cache persistence (B17)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rehydrates on construction: value visible synchronously, NO fetch issued', async () => {
    const fetchFn = vi.fn(async () => 'fetched');
    const { persister } = spyPersister<string, string>(new Map([['k1', 'rehydrated']]));

    const cache = createCache<string, string>(fetchFn, { persister });

    expect(persister.load).toHaveBeenCalledTimes(1);
    expect(cache.get('k1')).toBe('rehydrated');

    const seen = await firstValueFrom(cache.observe('k1').pipe(filter((v) => v !== undefined), take(1)));
    expect(seen).toBe('rehydrated');
    expect(fetchFn).not.toHaveBeenCalled();

    cache.dispose();
  });

  it('saves on mutation, debounced — a burst coalesces into one save', () => {
    const { persister } = spyPersister<string, string>();
    const cache = createCache<string, string>(async () => 'x', { persister });

    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '3');
    expect(persister.save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(persister.save).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(persister.save).mock.calls[0]![0];
    expect(saved.get('a')).toBe('3');
    expect(saved.get('b')).toBe('2');

    cache.dispose();
  });

  it('applies an external change: observers and snapshots see the replacement', async () => {
    const { persister, pushExternal } = spyPersister<string, string>(new Map([['k', 'old']]));
    const cache = createCache<string, string>(async () => 'x', { persister });

    pushExternal(new Map([['k', 'from-other-tab']]));

    expect(cache.get('k')).toBe('from-other-tab');
    const seen = await firstValueFrom(cache.observe('k').pipe(filter((v) => v === 'from-other-tab'), take(1)));
    expect(seen).toBe('from-other-tab');

    cache.dispose();
  });

  it('dispose flushes the pending save synchronously, then is inert', () => {
    const { persister, pushExternal } = spyPersister<string, string>();
    const cache = createCache<string, string>(async () => 'x', { persister });

    cache.set('a', '1');
    expect(persister.save).not.toHaveBeenCalled();

    cache.dispose();
    // The flush is part of disposal itself — the KB-switch teardown must not
    // lose the last write.
    expect(persister.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persister.save).mock.calls[0]![0].get('a')).toBe('1');

    // Inert afterwards: no further saves, external changes ignored.
    vi.advanceTimersByTime(200);
    expect(persister.save).toHaveBeenCalledTimes(1);
    pushExternal(new Map([['b', '2']]));
    expect(cache.get('b')).toBeUndefined();
  });

  it('never persists failure state: an exhausted key saves nothing', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('down'); });
    const { persister } = spyPersister<string, string>();
    const cache = createCache<string, string>(fetchFn, { persister });

    const errored = new Promise<Error>((resolve) => {
      cache.observe('k').subscribe({ error: (e: Error) => resolve(e) });
    });
    // Drive the B14 attempt + retry to exhaustion under fake timers.
    await vi.runAllTimersAsync();
    await errored;

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(persister.save).not.toHaveBeenCalled();

    cache.dispose();
    // Nothing was ever mutated, so even the dispose flush has nothing pending.
    expect(persister.save).not.toHaveBeenCalled();
  });

  it('an external change is applied but never echoed back as a save (no cross-tab ping-pong)', () => {
    const { persister, pushExternal } = spyPersister<string, string>();
    const cache = createCache<string, string>(async () => 'x', { persister });

    pushExternal(new Map([['k', 'from-other-tab']]));
    expect(cache.get('k')).toBe('from-other-tab');

    // The other tab's save always re-stamps writtenAt, so an echoed save
    // would differ byte-wise and re-fire its storage event: A saves → B
    // echoes → A echoes → … . Applying without echoing breaks the loop.
    vi.advanceTimersByTime(200);
    expect(persister.save).not.toHaveBeenCalled();

    // A real local mutation afterwards still saves normally.
    cache.set('k2', 'local');
    vi.advanceTimersByTime(50);
    expect(persister.save).toHaveBeenCalledTimes(1);

    cache.dispose();
  });

  it('a throwing save is best-effort: neither the debounced path nor the dispose flush breaks', () => {
    const { persister } = spyPersister<string, string>();
    vi.mocked(persister.save).mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const cache = createCache<string, string>(async () => 'x', { persister });

    cache.set('a', '1');
    // Debounced save fires and throws inside its timer — must not propagate.
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(cache.get('a')).toBe('1');

    cache.set('b', '2');
    // Dispose flush hits the throwing save — teardown must still complete.
    expect(() => cache.dispose()).not.toThrow();
  });

  it('without options, behavior is unchanged (no persister calls anywhere)', async () => {
    const cache = createCache<string, string>(async () => 'v');
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
    cache.dispose();
  });
});
