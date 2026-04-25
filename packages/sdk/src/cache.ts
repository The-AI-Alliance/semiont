/**
 * RxJS-native read-through cache primitive.
 *
 * Behavioral contract: packages/api-client/docs/CACHE-SEMANTICS.md (B1–B13).
 *
 * Framework-agnostic: no React, no dependency on any namespace. Used by
 * `BrowseNamespace` to back its per-key stores, but equally usable from
 * CLI, MCP, or worker code.
 *
 * Shape:
 *   - `observe(key)`: returns an Observable<V | undefined> that triggers
 *     a fetch on first subscription for a missing key, dedup-joins any
 *     concurrent fetch, and emits the stored value thereafter.
 *   - `invalidate(key)`: stale-while-revalidate — keeps the current
 *     value visible to observers, clears the in-flight guard, starts a
 *     fresh fetch. If the previous fetch was orphaned (SSE torn down,
 *     response lost), this is how the cache recovers.
 *   - `remove(key)`: drops the cache entry entirely. Used for entity
 *     deletions (B13a). No refetch.
 *   - `set(key, value)`: writes through without a fetch. Used when a
 *     bus event carries the new value inline (B13b).
 *   - `invalidateAll()`: per-key SWR refetch of every currently-cached
 *     entry. Used by gap-detection paths.
 *   - `dispose()`: completes the store so observers unsubscribe.
 *
 * What's deliberately out:
 *   - No subscriber ref-counting / GC of unobserved keys. The per-key
 *     observable memo grows with the set of observed keys for the cache's
 *     lifetime (B11). Acceptable given cache lifetime == client lifetime.
 *   - No TTL / cacheTime. Entries are evicted only by explicit remove.
 *   - No retry / backoff. A failing fetch leaves the cache unchanged
 *     (B6); the caller drives retry via invalidate.
 */

import { BehaviorSubject, Observable, distinctUntilChanged, map } from 'rxjs';

export interface Cache<K, V> {
  /** Observable stream of the value at `key`. Triggers a fetch if not cached. */
  observe(key: K): Observable<V | undefined>;

  /** Synchronous snapshot of the current value, without triggering a fetch. */
  get(key: K): V | undefined;

  /** Iterator of currently-cached keys. For invalidateAll and diagnostics. */
  keys(): K[];

  /**
   * Mark the entry stale and refetch. Keeps the previous value visible
   * to observers during the refetch (stale-while-revalidate).
   */
  invalidate(key: K): void;

  /** Drop the entry from the cache. No refetch. */
  remove(key: K): void;

  /** Write-through: set the value directly without a fetch. */
  set(key: K, value: V): void;

  /** Per-key SWR refetch of every currently-cached entry. */
  invalidateAll(): void;

  /** Release the underlying subject. Observers complete. */
  dispose(): void;
}

export function createCache<K, V>(fetchFn: (key: K) => Promise<V>): Cache<K, V> {
  const store$ = new BehaviorSubject<Map<K, V>>(new Map());
  const inflight = new Set<K>();
  const obsCache = new Map<K, Observable<V | undefined>>();

  const doFetch = async (key: K): Promise<void> => {
    // In-flight guard: concurrent first-observations deduplicate (B3).
    // `invalidate` clears the guard before calling doFetch, which is the
    // orphan-recovery mechanism documented in B7 and B9.
    if (inflight.has(key)) return;
    inflight.add(key);
    try {
      const value = await fetchFn(key);
      // Atomic update: one `.next` with a fresh Map reference so
      // downstream `distinctUntilChanged` sees the transition (B5).
      const next = new Map(store$.value);
      next.set(key, value);
      store$.next(next);
    } catch {
      // B6: fetch failure leaves the previous state intact. Observer
      // that was seeing `undefined` stays at `undefined`; observer
      // that was seeing a stale value keeps the stale value.
    } finally {
      inflight.delete(key);
    }
  };

  return {
    observe(key: K): Observable<V | undefined> {
      if (!store$.value.has(key) && !inflight.has(key)) {
        void doFetch(key);
      }
      // B4: return a stable Observable per key.
      let obs = obsCache.get(key);
      if (!obs) {
        obs = store$.pipe(
          map((m) => m.get(key)),
          distinctUntilChanged(),
        );
        obsCache.set(key, obs);
      }
      return obs;
    },

    get(key: K): V | undefined {
      return store$.value.get(key);
    },

    keys(): K[] {
      return [...store$.value.keys()];
    },

    invalidate(key: K): void {
      // B7: do NOT erase the value. Clear the guard (B9 orphan recovery)
      // and trigger a fresh fetch. Observers keep seeing the stale value
      // until the new value replaces it.
      inflight.delete(key);
      void doFetch(key);
    },

    remove(key: K): void {
      // B13a: drop the entry. The value is gone; observers see `undefined`.
      const next = new Map(store$.value);
      next.delete(key);
      store$.next(next);
      inflight.delete(key);
    },

    set(key: K, value: V): void {
      // B13b: write-through. No fetch. Atomic update.
      const next = new Map(store$.value);
      next.set(key, value);
      store$.next(next);
    },

    invalidateAll(): void {
      // Per-key SWR refetch of every currently-cached entry. Each entry
      // keeps its stale value until its refetch resolves.
      for (const key of store$.value.keys()) {
        inflight.delete(key);
        void doFetch(key);
      }
    },

    dispose(): void {
      store$.complete();
      obsCache.clear();
      inflight.clear();
    },
  };
}
