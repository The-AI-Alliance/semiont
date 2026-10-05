/**
 * Contract tests for the `Cache<K, V>` primitive.
 *
 * These mirror the B1–B16 behaviors spec'd in
 * `docs/protocol/CACHE-SEMANTICS.md`, but assert them against
 * the primitive directly (no BrowseNamespace, no busRequest). The
 * `cache-semantics.test.ts` suite covers the same behaviors at the
 * integration layer; passing both means the primitive is a correct
 * substrate and `browse.ts` wires it up correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import { map, firstValueFrom, filter } from 'rxjs';
import { createCache, isReady, type CacheState } from '../cache';

/**
 * Collector projection for sequence assertions: pending → undefined,
 * ready → value, failed → its Error (failure is an EMISSION — it shows
 * up IN the sequence, not on the error callback).
 */
const st = <V,>(s: CacheState<V>): V | undefined | Error =>
  s.status === 'ready' ? s.value : s.status === 'failed' ? s.error : undefined;

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function firstDefined<T>(obs: import('rxjs').Observable<CacheState<T>>): Promise<T> {
  return firstValueFrom(obs.pipe(filter(isReady), map((s) => s.value)));
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

    it('emits pending before the fetch resolves, then the value', async () => {
      let resolveFetch!: (v: string) => void;
      const fetchFn = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveFetch = r; }));
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined | Error> = [];
      cache.observe('k1').subscribe((s) => seen.push(st(s)));
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
    it('observers never see pending after ready around a successful fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined | Error> = [];
      cache.observe('k').subscribe((s) => seen.push(st(s)));
      await firstDefined(cache.observe('k'));
      // Only the first emission, before the fetch resolves, is `pending`
      // (projected to undefined); nothing after it is.
      expect(seen[0]).toBeUndefined();
      expect(seen.slice(1).every((v) => v !== undefined)).toBe(true);
    });
  });

  describe('B6 — fetch failure leaves the previous state intact', () => {
    it('empty key: store stays empty after chain exhaustion, observers see `failed` (B15), and invalidate + a fresh subscription recover', async () => {
      // Two rejections exhaust the observe attempt + its B14 retry. B15: the
      // value-less terminal failure reaches the subscriber as `failed`, not
      // as the silent pending-forever state the liveness axioms forbid (L1);
      // the STORE is not written (B6 — `get` stays undefined).
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('v1');
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined | Error> = [];
      const errors: unknown[] = [];
      cache.observe('k').subscribe({ next: (s) => seen.push(st(s)), error: (e) => errors.push(e) });
      await flush();
      // Failure is an EMISSION — it lands IN the sequence; the stream
      // never errors and stays alive.
      expect(errors).toEqual([]);
      expect(seen[0]).toBeUndefined();
      expect(seen[seen.length - 1]).toBeInstanceOf(Error);
      expect((seen[seen.length - 1] as Error).message).toBe('boom');
      expect(cache.get('k')).toBeUndefined(); // store untouched

      // Guard + marker released: invalidate triggers a new fetch that
      // succeeds; recovery observed via a fresh subscription — the
      // hook-remount shape.
      cache.invalidate('k');
      await flush();
      const late = await firstDefined(cache.observe('k'));
      expect(late).toBe('v1');
    });

    it('previously-fresh value survives a failed refetch', async () => {
      // Two rejections exhaust the invalidate refetch + its B14 retry.
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce('v1')
        .mockRejectedValueOnce(new Error('boom'))
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
      const seen: Array<string | undefined | Error> = [];
      cache.observe('k').subscribe((s) => seen.push(st(s)));
      await firstDefined(cache.observe('k'));

      const beforeCount = seen.length;
      cache.invalidate('k');
      // Immediately after invalidate, no new emission yet.
      expect(seen.length).toBe(beforeCount);
      await flush();

      const defined = seen.filter((v) => v !== undefined);
      expect(defined).toEqual(['v1', 'v2']); // no pending in between
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
      cache.remove('k', new Error('gone'));
      expect(cache.observe('k')).toBe(obs);
      cache.set('k', 'direct');
      expect(cache.observe('k')).toBe(obs);
    });
  });

  describe('B13a — remove ends the key: failed with what it was given, and no refetch', () => {
    it('remove clears the cached value and does not issue a fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('k'));
      expect(fetchFn).toHaveBeenCalledTimes(1);
      cache.remove('k', new Error('gone'));
      expect(cache.get('k')).toBeUndefined();
      // No refetch happened.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('its observer goes from ready straight to failed, with the error remove was given', async () => {
      const cache = createCache<string, string>(vi.fn().mockResolvedValue('v1'));
      const seen: Array<CacheState<string>> = [];
      cache.observe('k').subscribe((s) => seen.push(s));
      await firstDefined(cache.observe('k'));
      const gone = new Error('gone');
      cache.remove('k', gone);
      // Never `pending` between: that would be a wait with no request behind it (L1).
      expect(seen.map((s) => s.status)).toEqual(['pending', 'ready', 'failed']);
      expect(seen.at(-1)).toEqual({ status: 'failed', error: gone });
    });

    it('the key is still known, and an observer arriving at it asks again (B15)', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v1');
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('k'));
      cache.remove('k', new Error('gone'));
      expect(cache.known('k')).toBe(true);
      expect(cache.keys()).toEqual(['k']);

      await firstDefined(cache.observe('k'));
      expect(fetchFn).toHaveBeenCalledTimes(2);
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
    it('refetches every cached entry, one per key', async () => {
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

  describe('keys() — every key the cache knows (B20)', () => {
    it('lists a key from the moment it is asked for: being fetched, then holding its value', async () => {
      let resolveFetch!: (v: string) => void;
      const fetchFn = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveFetch = r; }));
      const cache = createCache<string, string>(fetchFn);
      expect(cache.keys()).toEqual([]);
      cache.observe('k').subscribe(() => {});
      expect(cache.keys()).toEqual(['k']);
      resolveFetch('v');
      await flush();
      expect(cache.keys()).toEqual(['k']);
    });

    it('lists a failed key, which invalidateAll then asks for again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const fetchFn = vi.fn().mockRejectedValue(new Error('down'));
        const cache = createCache<string, string>(fetchFn);
        const seen: string[] = [];
        cache.observe('k').subscribe((s) => seen.push(s.status));
        await flush();
        await flush();
        expect(seen.at(-1)).toBe('failed');
        expect(cache.keys()).toEqual(['k']);

        fetchFn.mockResolvedValue('v');
        cache.invalidateAll();
        await flush();
        expect(seen.at(-1)).toBe('ready');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('fetch — one-shot fresh', () => {
    it('always re-fetches (returns the fresh value, not the memo)', async () => {
      let n = 0;
      const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(`v${++n}`));
      const cache = createCache<string, string>(fetchFn);
      expect(await cache.fetch('k')).toBe('v1');
      expect(await cache.fetch('k')).toBe('v2'); // fresh, not memoized 'v1'
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('dedups concurrent fetches for the same key', async () => {
      let resolveFetch!: (v: string) => void;
      const fetchFn = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveFetch = r; }));
      const cache = createCache<string, string>(fetchFn);
      const a = cache.fetch('k');
      const b = cache.fetch('k');
      resolveFetch('v1');
      expect(await a).toBe('v1');
      expect(await b).toBe('v1');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('rejects on failure; subscribers are never errored and recover via the B14 retry', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('v1');
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined | Error> = [];
      const errors: unknown[] = [];
      cache.observe('k').subscribe({ next: (s) => seen.push(st(s)), error: (e) => errors.push(e) });
      // The awaiter joins the (failing) in-flight fetch and sees the rejection…
      await expect(cache.fetch('k')).rejects.toThrow('boom');
      expect(errors).toEqual([]); // …but the subscriber is never errored (B6)
      // …and the observe path's B14 retry recovers the subscriber.
      await flush();
      expect(seen[seen.length - 1]).toBe('v1');
    });
  });

  describe('B14 — SWR fetch failure retries once (anti-starvation)', () => {
    // Motivating failure: a one-shot busRequest reply lost on the wire (SSE
    // connection swap) times out and rejects; without a bounded retry, every
    // subscriber of a never-loaded key starves silently until some future
    // observe()/invalidate() happens to act.

    it('observe path: a failed first fetch is re-issued once and subscribers recover', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('bus.timeout: reply lost'))
        .mockResolvedValueOnce('v1');
      const cache = createCache<string, string>(fetchFn);
      const seen: Array<string | undefined | Error> = [];
      cache.observe('k').subscribe((s) => seen.push(st(s)));
      await flush();
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(seen[seen.length - 1]).toBe('v1');
    });

    it('caps at one retry: a persistently failing key is `failed` for its observers (B15) without a tight loop, and a later observe() recovers it', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('down'));
      const cache = createCache<string, string>(fetchFn);
      const states: string[] = [];
      cache.observe('k').subscribe((s) => states.push(s.status));
      await flush();
      expect(fetchFn).toHaveBeenCalledTimes(2); // attempt + one retry, then idle
      expect(states[states.length - 1]).toBe('failed'); // …surfaced, not silent (B15)
      await flush();
      expect(fetchFn).toHaveBeenCalledTimes(2); // no tight loop

      // Recoverable: observe() on the failed key clears the marker and
      // starts a fresh attempt chain — the failed state is never latched.
      fetchFn.mockResolvedValueOnce('v-late');
      const v = await firstDefined(cache.observe('k'));
      expect(v).toBe('v-late');
    });

    it('invalidate path: a failed SWR refetch retries once; stale value survives throughout (B6)', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce('v1')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('v2');
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('k'));
      cache.invalidate('k');
      expect(cache.get('k')).toBe('v1'); // stale value visible during refetch + retry
      await flush();
      expect(cache.get('k')).toBe('v2');
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('await path is untouched: fetch() rejects without auto-retry (caller owns retry policy)', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('v');
      const cache = createCache<string, string>(fetchFn);
      await expect(cache.fetch('k')).rejects.toThrow('boom');
      await flush();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('B15 — terminal failure of a value-less key is `failed` for its observers', () => {
    // Without B15, axioms L1/L2 are falsified under schedule ⟨reject-emit⟩:
    // after B14 exhaustion a value-less key's subscribers would see
    // `pending` forever — the forbidden fourth state.

    const exhaust = () =>
      vi.fn().mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost'));

    it('a subscriber attaching AFTER exhaustion RECOVERS — marker cleared, fresh chain', async () => {
      // The fetch decision runs at subscribe time, so ARRIVING at a failed
      // key recovers it: the marker clears and a fresh chain runs — what a
      // remount needs. Subscribers present AT exhaustion see `failed`;
      // nobody is ever silently pending (L1).
      const fetchFn = exhaust();
      const cache = createCache<string, string>(fetchFn);
      const obs = cache.observe('k');

      const firstStates: string[] = [];
      obs.subscribe((s) => firstStates.push(s.status));
      await flush(); // chain exhausts → the attached subscriber sees `failed` (hot push)
      expect(firstStates[firstStates.length - 1]).toBe('failed');

      fetchFn.mockResolvedValue('recovered');
      const seen: Array<string | undefined | Error> = [];
      const errors: unknown[] = [];
      obs.subscribe({ next: (s) => seen.push(st(s)), error: (e) => errors.push(e) });
      await flush();
      expect(errors).toEqual([]); // the stream does not error
      expect(seen[seen.length - 1]).toBe('recovered'); // the fresh chain delivered
    });

    it('observe() after exhaustion clears the marker: the new subscription ends on the value of the fresh chain', async () => {
      const fetchFn = exhaust().mockResolvedValueOnce('v2');
      const cache = createCache<string, string>(fetchFn);
      cache.observe('k').subscribe({ next: () => {}, error: () => {} });
      await flush(); // exhausted, marker set

      const errors: unknown[] = [];
      const seen: Array<string | undefined | Error> = [];
      cache.observe('k').subscribe({ next: (s) => seen.push(st(s)), error: (e) => errors.push(e) });
      await flush();
      expect(errors).toEqual([]); // the stream does not error
      expect(seen[seen.length - 1]).toBe('v2');
    });

    it('a key WITH a stale value keeps it when the refetch and its retry fail — B6 stale-beats-error', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce('v1')
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'));
      const cache = createCache<string, string>(fetchFn);
      const errors: unknown[] = [];
      cache.observe('k').subscribe({ next: () => {}, error: (e) => errors.push(e) });
      await firstDefined(cache.observe('k'));
      cache.invalidate('k'); // refetch + retry both fail — but a value exists
      await flush();
      expect(errors).toEqual([]);
      expect(cache.get('k')).toBe('v1');
    });

    it('set() supersedes the failure marker', async () => {
      const cache = createCache<string, string>(exhaust());
      cache.observe('k').subscribe({ next: () => {}, error: () => {} });
      await flush(); // exhausted, marker set
      cache.set('k', 'written');
      const v = await firstDefined(cache.observe('k'));
      expect(v).toBe('written'); // the write superseded the failure
    });

    it('a fetch() success while the marker is set clears it — a later subscriber serves the value, no refetch', async () => {
      const fetchFn = exhaust().mockResolvedValueOnce('v3');
      const cache = createCache<string, string>(fetchFn);
      const obs = cache.observe('k');
      obs.subscribe({ next: () => {}, error: () => {} }); // subscription starts the chain
      await flush(); // exhausted, marker set
      await expect(cache.fetch('k')).resolves.toBe('v3'); // await path succeeds → marker cleared
      const errors: unknown[] = [];
      const seen: Array<string | undefined | Error> = [];
      obs.subscribe({ next: (s) => seen.push(st(s)), error: (e) => errors.push(e) });
      expect(errors).toEqual([]); // marker gone — no error, and (store populated)
      expect(seen[seen.length - 1]).toBe('v3'); // …no fresh chain either: the value serves
      expect(fetchFn).toHaveBeenCalledTimes(3); // 2 exhaust + 1 fetch(); the late subscribe fetched nothing
    });
  });

  describe('one state per key — every observer of a key holds the same state', () => {
    // The cache holds the failure beside the values, so a key has one state.
    // Were `failed` only an event pushed to whoever is subscribed at
    // exhaustion, an observer that stayed would hold `failed` while one
    // arriving a moment later held `pending`: two answers to "what state is
    // this key in".

    const exhaust = () =>
      vi.fn().mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost'));

    /** A fetch the test settles by hand. */
    function deferred(): { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void } {
      let resolve!: (v: string) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('an arriving observer starts recovery, and the one already there sees pending too', async () => {
      const fetchFn = exhaust();
      const cache = createCache<string, string>(fetchFn);
      const stayed: string[] = [];
      cache.observe('k').subscribe((s) => stayed.push(s.status));
      await flush();
      expect(stayed).toEqual(['pending', 'failed']);

      const recovery = deferred();
      fetchFn.mockReturnValueOnce(recovery.promise);
      const arrived: string[] = [];
      cache.observe('k').subscribe((s) => arrived.push(s.status));
      // A fetch is in flight for the key, so the key is pending, for both.
      expect(arrived).toEqual(['pending']);
      expect(stayed).toEqual(['pending', 'failed', 'pending']);

      recovery.resolve('recovered');
      await flush();
      expect(stayed).toEqual(['pending', 'failed', 'pending', 'ready']);
      expect(arrived).toEqual(['pending', 'ready']);
    });

    it('a recovery that fails again returns every observer to failed', async () => {
      const fetchFn = exhaust().mockRejectedValue(new Error('still lost'));
      const cache = createCache<string, string>(fetchFn);
      const stayed: string[] = [];
      cache.observe('k').subscribe((s) => stayed.push(s.status));
      await flush();
      const arrived: string[] = [];
      cache.observe('k').subscribe((s) => arrived.push(s.status));
      await flush();
      expect(stayed).toEqual(['pending', 'failed', 'pending', 'failed']);
      expect(arrived).toEqual(['pending', 'failed']);
    });

    it('invalidate of a failed key returns its observers to pending (B8)', async () => {
      const fetchFn = exhaust();
      const cache = createCache<string, string>(fetchFn);
      const states: string[] = [];
      cache.observe('k').subscribe((s) => states.push(s.status));
      await flush();

      const refetch = deferred();
      fetchFn.mockReturnValueOnce(refetch.promise);
      cache.invalidate('k');
      expect(states).toEqual(['pending', 'failed', 'pending']);
      refetch.resolve('v');
      await flush();
      expect(states).toEqual(['pending', 'failed', 'pending', 'ready']);
    });

    it('a value arriving at a failed key moves it straight to ready, with no pending between', async () => {
      const viaFetch = exhaust().mockResolvedValueOnce('fetched');
      const fetched = createCache<string, string>(viaFetch);
      const afterFetch: string[] = [];
      fetched.observe('k').subscribe((s) => afterFetch.push(s.status));
      await flush();
      await fetched.fetch('k');
      expect(afterFetch).toEqual(['pending', 'failed', 'ready']);

      const written = createCache<string, string>(exhaust());
      const afterSet: string[] = [];
      written.observe('k').subscribe((s) => afterSet.push(s.status));
      await flush();
      written.set('k', 'written');
      expect(afterSet).toEqual(['pending', 'failed', 'ready']);
    });

    it('a late observer of a failed key is told the failure of its own recovery, not the old one', async () => {
      const fetchFn = exhaust()
        .mockRejectedValueOnce(new Error('second chain, first try'))
        .mockRejectedValueOnce(new Error('second chain, retry'));
      const cache = createCache<string, string>(fetchFn);
      cache.observe('k').subscribe(() => {});
      await flush();
      const seen: Array<string | undefined | Error> = [];
      cache.observe('k').subscribe((s) => seen.push(st(s)));
      await flush();
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeUndefined();
      expect((seen[1] as Error).message).toBe('second chain, retry');
    });
  });

  describe('dispose()', () => {
    it('completes the store and observers receive no further values', async () => {
      const cache = createCache<string, string>(vi.fn().mockResolvedValue('v'));
      const seen: Array<string | undefined | Error> = [];
      cache.observe('k').subscribe({
        next: (s) => seen.push(st(s)),
        complete: () => seen.push('COMPLETE' as unknown as string),
      });
      await firstDefined(cache.observe('k'));
      cache.dispose();
      expect(seen[seen.length - 1]).toBe('COMPLETE');
    });
  });

  // B16 — disposal is terminal and inert. Without it, a B14 retry chain
  // straddling client teardown pushes a B15 `bus.closed` failure into
  // whatever is subscribed. The rule is structural: disposal
  // completes every per-key observable and stuns all later acts — so a
  // teardown-straddling failure has no observers to reach and no retry to
  // issue. No error-code special-casing anywhere: L1 stays unconditional.
  describe('B16 — dispose() is terminal and inert', () => {
    it('a retry chain straddling dispose() goes quiet: no retry, no failure, no breadcrumb; observers complete at dispose', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        let rejectFirst!: (e: Error) => void;
        const fetchFn = vi
          .fn()
          .mockImplementationOnce(() => new Promise<string>((_, rej) => { rejectFirst = rej; }))
          .mockRejectedValue(new Error('retry would also fail'));
        const cache = createCache<string, string>(fetchFn);

        const events: string[] = [];
        cache.observe('k').subscribe({
          next: (s) => { if (s.status !== 'pending') events.push('next'); },
          error: () => events.push('error'),
          complete: () => events.push('complete'),
        });

        cache.dispose();                       // teardown with attempt 1 in flight
        rejectFirst(new Error('late loss'));   // the straddling failure lands
        await flush();
        await flush();

        expect(events).toEqual(['complete']);      // completed at dispose — no `failed`, no error
        expect(fetchFn).toHaveBeenCalledTimes(1);  // no B14 re-issue after dispose
        expect(warnSpy).not.toHaveBeenCalled();    // no [cache RETRY]/[cache IDLE] teardown noise
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('post-dispose observe() completes immediately and issues no fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v');
      const cache = createCache<string, string>(fetchFn);
      cache.dispose();

      const events: string[] = [];
      cache.observe('k').subscribe({
        next: () => events.push('next'),
        error: () => events.push('error'),
        complete: () => events.push('complete'),
      });
      await flush();

      expect(events).toEqual(['complete']);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('post-dispose invalidate()/invalidateAll()/fetch() issue no fetches; fetch() rejects', async () => {
      const fetchFn = vi.fn().mockResolvedValue('v');
      const cache = createCache<string, string>(fetchFn);
      await firstDefined(cache.observe('k'));   // one real fetch, so invalidateAll has a key
      cache.dispose();

      cache.invalidate('k');
      cache.invalidateAll();
      // The code a request of a closed bus fails with.
      await expect(cache.fetch('k')).rejects.toMatchObject({ code: 'bus.closed' });
      await flush();

      expect(fetchFn).toHaveBeenCalledTimes(1); // only the pre-dispose fetch
    });

    it('dispose() is idempotent', () => {
      const cache = createCache<string, string>(vi.fn().mockResolvedValue('v'));
      cache.dispose();
      expect(() => cache.dispose()).not.toThrow();
    });
  });
});
