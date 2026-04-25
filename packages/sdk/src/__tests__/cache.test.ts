/**
 * Contract tests for the `Cache<K, V>` primitive.
 *
 * These mirror the B1–B13 behaviors spec'd in
 * `packages/api-client/docs/CACHE-SEMANTICS.md`, but assert them against
 * the primitive directly (no BrowseNamespace, no busRequest). The
 * `cache-semantics.test.ts` suite covers the same behaviors at the
 * integration layer; passing both means the primitive is a correct
 * substrate and `browse.ts` wires it up correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom, filter } from 'rxjs';
import { createCache } from '../cache';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function firstDefined<T>(obs: import('rxjs').Observable<T | undefined>): Promise<T> {
  return firstValueFrom(obs.pipe(filter((v): v is T => v !== undefined)));
}

describe('Cache<K, V>', () => {
  describe('B1 — first observation triggers a fetch', () => {
    it('fetches on first observe and emits the resolved value', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      const v = await firstDefined(cache.observe('k1'));
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith('k1');
      expect(v).toBe('v1');
    });

    it('emits undefined before the fetch resolves, then the value', async () => {
      let resolveFetch!: (v: string) => void;
      const fetchFn = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveFetch = r; }));
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined> = [];
      cache.observe('k1').subscribe((v) => seen.push(v));
      expect(seen).toEqual([undefined]);
      resolveFetch('v1');
      await flush();
      expect(seen).toEqual([undefined, 'v1']);
    });
  });

  describe('B2 — subsequent observations reuse the cached value', () => {
    it('re-observe does not issue a second fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('k1'));
      await firstDefined(cache.observe('k1'));
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('B3 — concurrent first observations deduplicate', () => {
    it('two simultaneous observes produce exactly one fetch', () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      cache.observe('k1').subscribe(() => {});
      cache.observe('k1').subscribe(() => {});
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('B4 — observers share one observable per key', () => {
    it('returns a referentially-equal observable for the same key', () => {
      const cache = createCache<string, string>(vi.fn().mockResolvedValue('v'));
      const a = cache.observe('k');
      const b = cache.observe('k');
      expect(a).toBe(b);
    });
  });

  describe('B5 — fetch success updates the store atomically', () => {
    it('observers never see undefined-after-defined around a successful fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined> = [];
      cache.observe('k').subscribe((v) => seen.push(v));
      await firstDefined(cache.observe('k'));
      // Only one undefined at index 0 (initial emission before fetch resolves);
      // everything after must be defined.
      expect(seen[0]).toBeUndefined();
      expect(seen.slice(1).every((v) => v !== undefined)).toBe(true);
    });
  });

  describe('B6 — fetch failure leaves the previous state intact', () => {
    it('empty key stays empty after a rejected fetch; guard is released', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('v1');
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined> = [];
      cache.observe('k').subscribe((v) => seen.push(v));
      await flush();
      expect(seen).toEqual([undefined]);

      // Guard released: invalidate triggers a new fetch that succeeds.
      cache.invalidate('k');
      await flush();
      expect(seen[seen.length - 1]).toBe('v1');
    });

    it('previously-fresh value survives a failed refetch', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce('v1')
        .mockRejectedValueOnce(new Error('boom'));
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('k'));
      cache.invalidate('k');
      await flush();
      expect(cache.get('k')).toBe('v1');
    });
  });

  describe('B7 — invalidate is stale-while-revalidate', () => {
    it('observer keeps seeing the stale value during the refetch', async () => {
      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(`v${callCount}`);
      });
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined> = [];
      cache.observe('k').subscribe((v) => seen.push(v));
      await firstDefined(cache.observe('k'));

      const beforeCount = seen.length;
      cache.invalidate('k');
      // Immediately after invalidate, no new emission yet.
      expect(seen.length).toBe(beforeCount);
      await flush();

      const defined = seen.filter((v): v is string => v !== undefined);
      expect(defined).toEqual(['v1', 'v2']); // no undefined in between
      expect(seen.slice(1).every((v) => v !== undefined)).toBe(true);
    });

    it('orphan recovery: invalidate fires a new fetch even while one is in flight', () => {
      let resolveFetch!: (v: string) => void;
      const fetchFn = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveFetch = r; }));
      const cache = createCache<string, string>(fetchFn);
      cache.observe('k').subscribe(() => {});
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // Simulate the orphan case: the first fetch's response channel is
      // torn down and will never resolve. invalidate must issue a second
      // fetch immediately, not wait for the (never-resolving) first.
      cache.invalidate('k');
      expect(fetchFn).toHaveBeenCalledTimes(2);
      // Unblock the dangling fetch to avoid leaks in the test.
      resolveFetch('ignored');
    });

    it('last-write-wins when two fetches resolve in order', async () => {
      const values = ['first', 'second'];
      const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(values.shift()!));
      const cache = createCache<string, string>(fetchFn);
      cache.observe('k').subscribe(() => {});
      cache.invalidate('k');
      await flush();
      expect(cache.get('k')).toBe('second');
    });
  });

  describe('B8 — invalidate of an empty key triggers a fetch', () => {
    it('observer subsequently sees the fetched value', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      cache.invalidate('k'); // before any observe
      const v = await firstDefined(cache.observe('k'));
      expect(v).toBe('v1');
      // invalidate triggered a fetch; observe joined the existing in-flight guard.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('B10 — multiple keys are independent', () => {
    it('invalidate(a) does not affect b', async () => {
      const fetchFn = vi.fn().mockImplementation((k: string) => Promise.resolve(`v-${k}`));
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('a'));
      await firstDefined(cache.observe('b'));
      expect(fetchFn).toHaveBeenCalledTimes(2);
      cache.invalidate('a');
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(fetchFn).toHaveBeenLastCalledWith('a');
    });
  });

  describe('B11 — per-key observables are stable across the cache lifetime', () => {
    it('observable for a key is the same instance after invalidate/remove/set', async () => {
      const cache = createCache<string, string>(vi.fn().mockResolvedValue('v'));
      const obs = cache.observe('k');
      await firstDefined(obs);
      cache.invalidate('k');
      await flush();
      expect(cache.observe('k')).toBe(obs);
      cache.remove('k');
      expect(cache.observe('k')).toBe(obs);
      cache.set('k', 'direct');
      expect(cache.observe('k')).toBe(obs);
    });
  });

  describe('B13a — remove drops the entry without a refetch', () => {
    it('remove clears the cached value and does not issue a fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('k'));
      expect(fetchFn).toHaveBeenCalledTimes(1);
      cache.remove('k');
      expect(cache.get('k')).toBeUndefined();
      // No refetch happened.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('observer sees undefined after remove', async () => {
      const cache = createCache<string, string>(vi.fn().mockResolvedValue('v1'));
      const seen: Array<string | undefined> = [];
      cache.observe('k').subscribe((v) => seen.push(v));
      await firstDefined(cache.observe('k'));
      cache.remove('k');
      expect(seen[seen.length - 1]).toBeUndefined();
    });
  });

  describe('B13b — set writes through without a fetch', () => {
    it('set updates the cached value with no fetch call', () => {
      const fetchFn = vi.fn().mockResolvedValue('from-fetch');
      const cache = createCache<string, string>(fetchFn);
      cache.set('k', 'direct');
      expect(cache.get('k')).toBe('direct');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('observer subscribed after set sees the direct value without a fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('from-fetch');
      const cache = createCache<string, string>(fetchFn);
      cache.set('k', 'direct');
      const v = await firstDefined(cache.observe('k'));
      expect(v).toBe('direct');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('invalidateAll — per-key SWR refetch', () => {
    it('refetches every currently-cached entry, one per key', async () => {
      const fetchFn = vi.fn().mockImplementation((k: string) => Promise.resolve(`v-${k}`));
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('a'));
      await firstDefined(cache.observe('b'));
      expect(fetchFn).toHaveBeenCalledTimes(2);
      cache.invalidateAll();
      expect(fetchFn).toHaveBeenCalledTimes(4);
      const calls = fetchFn.mock.calls.map((c) => c[0]);
      expect(calls.slice(2).sort()).toEqual(['a', 'b']);
    });

    it('does not touch keys that were never observed', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v');
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('a'));
      cache.invalidateAll();
      expect(fetchFn.mock.calls.every((c) => c[0] === 'a')).toBe(true);
    });
  });

  describe('keys() — diagnostic access', () => {
    it('reflects currently-cached keys only (not in-flight)', async () => {
      let resolveFetch!: (v: string) => void;
      const fetchFn = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveFetch = r; }));
      const cache = createCache<string, string>(fetchFn);
      cache.observe('k').subscribe(() => {});
      expect(cache.keys()).toEqual([]);
      resolveFetch('v');
      await flush();
      expect(cache.keys()).toEqual(['k']);
    });
  });

  describe('dispose()', () => {
    it('completes the store and observers receive no further values', async () => {
      const cache = createCache<string, string>(vi.fn().mockResolvedValue('v'));
      const seen: Array<string | undefined> = [];
      cache.observe('k').subscribe({
        next: (v) => seen.push(v),
        complete: () => seen.push('COMPLETE' as unknown as string),
      });
      await firstDefined(cache.observe('k'));
      cache.dispose();
      expect(seen[seen.length - 1]).toBe('COMPLETE');
    });
  });
});
