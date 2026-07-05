/**
 * RxJS-native read-through cache primitive.
 *
 * Behavioral contract: packages/sdk/docs/CACHE-SEMANTICS.md (B1–B13).
 *
 * Framework-agnostic: no React, no dependency on any namespace. Used by
 * `BrowseNamespace` to back its per-key stores, but equally usable from
 * CLI, MCP, or worker code.
 *
 * Two consumption paths with different freshness semantics:
 *   - `observe(key)` (the subscribe path) is a stale-while-revalidate live
 *     view: it triggers a fetch on first subscription for a missing key,
 *     dedup-joins any concurrent fetch, then emits the stored value and
 *     re-emits on invalidation.
 *   - `fetch(key)` (the one-shot await path) forces a fresh fetch, so a
 *     re-read reflects writes rather than serving the memo.
 *
 * Shape:
 *   - `observe(key)`: Observable<V | undefined> — subscribe path (SWR).
 *   - `fetch(key)`: force a fresh fetch (bypassing the memo), update the
 *     store (so subscribers see it too), and resolve with the value —
 *     rejecting if the fetch fails. Concurrent calls for the same key share
 *     one in-flight fetch. Backs the one-shot `await` path.
 *   - `invalidate(key)`: stale-while-revalidate — keeps the current value
 *     visible to observers, clears the in-flight guard, starts a fresh
 *     fetch. Recovers an orphaned fetch (SSE torn down, response lost).
 *   - `remove(key)`: drops the cache entry entirely (B13a). No refetch.
 *   - `set(key, value)`: write-through without a fetch (B13b).
 *   - `invalidateAll()`: per-key SWR refetch of every currently-cached entry.
 *   - `dispose()`: completes the store so observers unsubscribe.
 *
 * What's deliberately out:
 *   - No subscriber ref-counting / GC of unobserved keys (B11). Acceptable
 *     given cache lifetime == client lifetime.
 *   - No TTL / cacheTime. Entries are evicted only by explicit remove.
 *   - Bounded retry on the SWR paths only (B14): a failed observe/invalidate
 *     fetch is re-issued exactly once, then the key goes idle. The
 *     `fetch`/await path never auto-retries — it surfaces the rejection so
 *     the caller owns retry policy.
 */

import { BehaviorSubject, Observable, distinctUntilChanged, map } from 'rxjs';

export interface Cache<K, V> {
  /** Observable stream of the value at `key` (SWR). Triggers a fetch if not cached. */
  observe(key: K): Observable<V | undefined>;

  /**
   * Force a fresh fetch for `key`, update the store (so subscribers see it),
   * and resolve with the fetched value — rejecting if the fetch fails.
   * Concurrent calls for the same key share one in-flight fetch. Backs the
   * one-shot `await` path: a re-read reflects writes rather than serving the
   * memoized value. Live-query *subscribers* (`observe`) keep B6 — a failed
   * fetch leaves their value untouched.
   */
  fetch(key: K): Promise<V>;

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
  /** In-flight fetch promise per key — dedups concurrent fetches (B3). */
  const inflight = new Map<K, Promise<V>>();
  const obsCache = new Map<K, Observable<V | undefined>>();

  /**
   * Run (or join) a fetch for `key`. Resolves with the value and updates the
   * store on success; rejects on failure WITHOUT touching the store (B6 —
   * subscribers keep their prior value / loading state). Concurrent callers
   * share the same promise.
   */
  const runFetch = (key: K): Promise<V> => {
    const existing = inflight.get(key);
    if (existing) return existing;

    // Definite-assignment: `p` is assigned synchronously below, before the
    // async `finally` (which references it) can run.
    let p!: Promise<V>;
    p = (async () => {
      try {
        const value = await fetchFn(key);
        // Atomic update: one `.next` with a fresh Map reference so
        // downstream `distinctUntilChanged` sees the transition (B5).
        const next = new Map(store$.value);
        next.set(key, value);
        store$.next(next);
        return value;
      } finally {
        // Only clear if we're still the in-flight entry — an `invalidate`
        // may have replaced us with a newer fetch (B9 orphan recovery).
        if (inflight.get(key) === p) inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };

  /**
   * Fetch driver for the swallowed SWR paths (observe / invalidate): retry
   * once on failure (B14), then go idle.
   *
   * The motivating failure is a lost one-shot reply — the busRequest timed
   * out because its SSE result raced a connection swap
   * (.plans/bugs/concurrent-browse-resource-starvation.md). Without a retry,
   * every subscriber of a never-loaded key starves silently until some future
   * observe()/invalidate() happens to act. Failures stay invisible to
   * subscribers (B6); the retry joins any fetch another caller started in the
   * meantime (B3), and an exhausted key is left idle-empty so the next
   * observe()/invalidate() starts a fresh chain. The `fetch`/await path never
   * comes through here — its caller sees the rejection and owns retry policy.
   */
  const runFetchSWR = (key: K): void => {
    void runFetch(key).catch((firstErr: unknown) => {
      // Always-on breadcrumb: the pre-B14 version of this path swallowed the
      // failure with zero trace, which is how lost replies starved silently
      // (.plans/bugs/concurrent-browse-resource-starvation.md). Not deduped —
      // a spamming retry line means fetches are failing repeatedly, which is
      // itself the signal.
      // eslint-disable-next-line no-console
      console.warn(
        `[cache RETRY] SWR fetch failed for key ${String(key)}; re-issuing once (B14):`,
        firstErr instanceof Error ? firstErr.message : firstErr,
      );
      void runFetch(key).catch((retryErr: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[cache IDLE] retry also failed for key ${String(key)}; going idle until the ` +
            `next observe()/invalidate() (B14):`,
          retryErr instanceof Error ? retryErr.message : retryErr,
        );
      });
    });
  };

  return {
    observe(key: K): Observable<V | undefined> {
      if (!store$.value.has(key) && !inflight.has(key)) {
        // Subscribe path: fire-and-forget, swallow failures so a subscriber
        // stays at its last value (B6); one bounded retry (B14). The
        // awaiter's `fetch` surfaces failures instead.
        runFetchSWR(key);
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

    fetch(key: K): Promise<V> {
      return runFetch(key);
    },

    get(key: K): V | undefined {
      return store$.value.get(key);
    },

    keys(): K[] {
      return [...store$.value.keys()];
    },

    invalidate(key: K): void {
      // B7: do NOT erase the value. Clear the guard (B9 orphan recovery)
      // and trigger a fresh fetch (with the B14 bounded retry). Observers
      // keep seeing the stale value until the new value replaces it.
      inflight.delete(key);
      runFetchSWR(key);
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
        runFetchSWR(key);
      }
    },

    dispose(): void {
      store$.complete();
      obsCache.clear();
      inflight.clear();
    },
  };
}
