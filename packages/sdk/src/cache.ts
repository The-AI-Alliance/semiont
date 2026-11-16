/**
 * RxJS-native read-through cache primitive.
 *
 * Behavioral contract: packages/sdk/docs/CACHE-SEMANTICS.md (B1–B16).
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
 *   - `dispose()`: terminal and inert (B16) — completes every per-key
 *     observable (subscribers detach cleanly) and stuns all later acts:
 *     no fetch, retry, breadcrumb, or B15 push may fire after disposal, so
 *     a retry chain straddling client teardown dies quietly instead of
 *     erroring observers (`bus.closed` disposal noise needs no special-case).
 *
 * What's deliberately out:
 *   - No subscriber ref-counting / GC of unobserved keys (B11). Acceptable
 *     given cache lifetime == client lifetime.
 *   - No TTL / cacheTime. Entries are evicted only by explicit remove.
 *   - Bounded retry on the SWR paths only (B14): a failed observe/invalidate
 *     fetch is re-issued exactly once, then the key goes idle. The
 *     `fetch`/await path never auto-retries — it surfaces the rejection so
 *     the caller owns retry policy.
 *   - Terminal failure of a VALUE-LESS key errors its observers (B15): when
 *     the B14 retry also fails and there is no cached value to serve, the
 *     key's observers get an error notification (replayed to late
 *     subscribers) instead of `undefined` forever — L1's forbidden fourth
 *     state (.plans/LIVENESS-AXIOMS.md; found by the P2 property suite).
 *     Retriable: the next observe()/invalidate()/set() clears the marker.
 *     Keys WITH a value keep B6 stale-beats-error, unchanged.
 */

import {
  BehaviorSubject,
  Observable,
  Subject,
  distinctUntilChanged,
  filter,
  map,
  merge,
  skip,
} from 'rxjs';

/**
 * B17 — optional persistence seam for a cache instance. `load` runs once at
 * construction (settled values only — B15 failure markers live outside the
 * store and are never serialized); `save` receives every store mutation,
 * debounced by the cache; `subscribe` is the cross-context sync hook (the
 * persister calls back when another tab/process wrote the same key).
 */
export interface CachePersister<K, V> {
  /** Called once at cache construction. Returns initial entries, or null for none. */
  load(): Map<K, V> | null;
  /** Called on store mutations, debounced by the cache; flushed on dispose. */
  save(entries: Map<K, V>): void;
  /** Optional cross-context sync; returns an unsubscribe function. */
  subscribe?(onExternalChange: (entries: Map<K, V>) => void): () => void;
}

/**
 * The three-outcome truth of a cache read (CACHE-CONTRACT D1, settled
 * 2026-07-29): pending (nothing to show yet), ready (a value — possibly
 * stale-while-revalidating, B7), or failed (B15 exhaustion of a value-less
 * key). `failed` is an EMISSION, not a stream death: the observable never
 * errors and never terminates on failure, so a subscription survives the
 * full pending → failed → (resubscribe) → pending → ready life cycle. A
 * two-state consumer no longer compiles — which is the point (SDK-DEBT L1:
 * nine call sites shipped against the hidden third outcome).
 */
export type CacheState<T> =
  | { status: 'pending' }
  | { status: 'ready'; value: T }
  | { status: 'failed'; error: Error };

/** Type guard for the settled-with-value state — the paved path for
 * `pipe(filter(isReady), map((s) => s.value))`, replacing the old
 * `filter((v) => v !== undefined)` idiom. */
export const isReady = <T,>(s: CacheState<T>): s is { status: 'ready'; value: T } =>
  s.status === 'ready';

/** Value-or-undefined projection for call sites that want the old shape
 * EXPLICITLY (the type still forces the choice at the boundary). */
export const readyValue = <T,>(s: CacheState<T>): T | undefined =>
  s.status === 'ready' ? s.value : undefined;

export interface Cache<K, V> {
  /** Observable stream of the state at `key` (SWR live view). Fetch fires on first subscribe. */
  observe(key: K): Observable<CacheState<V>>;

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

  /**
   * B17-Q — true while this cache's content may be ahead of (or racing) its
   * persisted document: any fetch in flight, or a debounced save pending.
   * The quiescence input to the resumption-bookmark flush gate — the
   * bookmark may only be flushed when every persisted cache is quiet, so it
   * can lag the persisted content but never lead it (C1).
   */
  persistencePending(): boolean;

  /** Release the underlying subject. Observers complete. */
  dispose(): void;
}

export function createCache<K, V>(
  fetchFn: (key: K) => Promise<V>,
  options?: {
    /** B17 — persistence seam. Omitted = today's in-memory-only behavior. */
    persister?: CachePersister<K, V>;
    /** Debounce window for persister.save. Default 50 ms. */
    saveDebounceMs?: number;
  },
): Cache<K, V> {
  const persister = options?.persister;
  const initialEntries = persister?.load() ?? new Map<K, V>();
  const store$ = new BehaviorSubject<Map<K, V>>(initialEntries);

  /**
   * B18 — keys restored from the persister that have NOT been revalidated
   * this session. A value read off disk is *stale-until-revalidated*: unlike
   * a value this session fetched, nothing guarantees it reflects server
   * truth. Treating the two alike is what made an annotation created
   * seconds before a reload invisible — the persisted document predated it,
   * `observe()` saw a populated store and issued no request, and no replay
   * could help (at failure time no resumption bookmark exists at all).
   * See .plans/bugs/annotation-lost-on-immediate-reload-after-create.md.
   */
  const rehydrated = new Set<K>(initialEntries.keys());
  /** In-flight fetch promise per key — dedups concurrent fetches (B3). */
  const inflight = new Map<K, Promise<V>>();
  const obsCache = new Map<K, Observable<CacheState<V>>>();

  /**
   * B16 — disposal is terminal and inert. Once set, no path may issue a
   * fetch, retry, or failure push: a B14 chain that straddles teardown
   * (busRequest resolving `bus.closed` mid-retry) must die quietly instead
   * of erroring observers that dispose() just completed. Checked at every
   * async resumption point in the SWR driver, not just at entry.
   */
  let disposed = false;

  /**
   * B15 — terminal-failure markers for VALUE-LESS keys. Set when the B14
   * retry also fails and the store holds nothing to serve; delivered to that
   * key's observers as an error notification — pushed via `failure$` to
   * subscribers attached at exhaustion time. A LATER subscriber clears the
   * marker and starts a fresh chain instead of replaying the stale error
   * (D3 subscribe-time recovery). Also cleared by invalidate()/set()/
   * remove() and by any fetch success, so the error state is always
   * retriable.
   */
  const failures = new Map<K, Error>();
  const failure$ = new Subject<{ key: K; error: Error }>();
  const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

  /**
   * B17 — debounced persistence. The initial emission (the loaded map) is
   * skipped: only mutations schedule a save. `dispose()` flushes a pending
   * save synchronously (the KB-switch teardown must not lose the last
   * write), then everything goes inert with the rest of B16.
   */
  const saveDebounceMs = options?.saveDebounceMs ?? 50;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeExternal: (() => void) | null = null;
  /**
   * Persistence is best-effort: a throwing save (localStorage quota, a
   * broken adapter) must never break the cache — and above all must never
   * break dispose(), which sits on the KB-switch teardown path.
   */
  const trySave = (entries: Map<K, V>): void => {
    try {
      persister?.save(entries);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cache PERSIST] save failed; persistence skipped (best-effort):',
        e instanceof Error ? e.message : e);
    }
  };
  /**
   * External changes are applied WITHOUT echoing a save back: the adapter
   * re-stamps `writtenAt` on every save, so an echo is never byte-identical
   * and would re-fire the other tab's storage event — an unbounded two-tab
   * ping-pong at the debounce cadence. BehaviorSubject emission is
   * synchronous, so the flag is set for exactly the external `next`.
   */
  let applyingExternal = false;
  if (persister) {
    store$.pipe(skip(1)).subscribe((entries) => {
      if (disposed || applyingExternal) return;
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        trySave(entries);
      }, saveDebounceMs);
    });
    unsubscribeExternal = persister.subscribe?.((entries) => {
      if (disposed) return;
      applyingExternal = true;
      try {
        store$.next(new Map(entries));
      } finally {
        applyingExternal = false;
      }
    }) ?? null;
  }

  /**
   * Run (or join) a fetch for `key`. Resolves with the value and updates the
   * store on success; rejects on failure WITHOUT touching the store (B6 —
   * subscribers keep their prior value / loading state). Concurrent callers
   * share the same promise.
   */
  const runFetch = (key: K): Promise<V> => {
    // B18 — a fetch is under way for this key from SOME path (observe's
    // revalidation, invalidate, or the await path), so it is no longer
    // merely restored-from-disk. Cleared before the dedup return: joining an
    // in-flight fetch counts as revalidating too.
    rehydrated.delete(key);
    const existing = inflight.get(key);
    if (existing) return existing;

    // Definite-assignment: `p` is assigned synchronously below, before the
    // async `finally` (which references it) can run.
    let p!: Promise<V>;
    p = (async () => {
      try {
        const value = await fetchFn(key);
        // A value arrived from ANY path — the key is live again (B15).
        failures.delete(key);
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
    if (disposed) return;
    void runFetch(key).catch((firstErr: unknown) => {
      // B16: teardown straddled the attempt — no retry, no breadcrumb noise.
      if (disposed) return;
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
        // B16: teardown straddled the retry — its failure has nowhere it
        // needs to go (observers completed at dispose).
        if (disposed) return;
        // eslint-disable-next-line no-console
        console.warn(
          `[cache IDLE] retry also failed for key ${String(key)}; going idle until the ` +
            `next observe()/invalidate() (B14):`,
          retryErr instanceof Error ? retryErr.message : retryErr,
        );
        // B15: with no cached value to serve, "idle" would leave observers
        // on `undefined` forever — the forbidden fourth state (L1). Surface
        // the terminal failure as an error notification instead. A key WITH
        // a stale value stays silent (B6 stale-beats-error).
        if (!store$.value.has(key)) {
          const error = toError(retryErr);
          failures.set(key, error);
          failure$.next({ key, error });
        }
      });
    });
  };

  return {
    observe(key: K): Observable<CacheState<V>> {
      // B4: return a stable Observable per key.
      let obs = obsCache.get(key);
      if (!obs) {
        const inner = merge(
          store$.pipe(
            map((m): CacheState<V> =>
              m.has(key)
                ? { status: 'ready', value: m.get(key) as V }
                : { status: 'pending' },
            ),
            distinctUntilChanged(
              (a, b) =>
                a.status === b.status &&
                (a.status !== 'ready' ||
                  Object.is(a.value, (b as { status: 'ready'; value: V }).value)),
            ),
          ),
          // B15 push: terminal failure of this (value-less) key is an
          // EMISSION — `{ status: 'failed' }` — never an RxJS error. The
          // subscription stays alive through failure; recovery is a fresh
          // subscribe (the D3 per-subscribe decision clears the marker).
          failure$.pipe(
            filter((f) => f.key === key),
            map((f): CacheState<V> => ({ status: 'failed', error: f.error })),
          ),
        );
        // D3 (CACHE-CONTRACT, settled 2026-07-29): the fetch decision runs
        // per SUBSCRIPTION, not per accessor call — calling an accessor is
        // pure (render-safe); the effect belongs to the observer that will
        // see its outcome. Every branch is idempotent under concurrent
        // subscribers (`inflight`, marker deletion), so N subscribers cost
        // one chain, same as before.
        obs = new Observable<CacheState<V>>((subscriber) => {
          if (disposed) {
            // B16: the store is completed, so the inner observable completes
            // subscribers immediately — just don't issue a fetch for a
            // client that no longer exists.
          } else if (failures.has(key)) {
            // B15 recovery: an observer ARRIVING at a failed key clears the
            // marker and starts a fresh attempt chain. Under subscribe-time
            // semantics this subsumes the old "replay the stale error to
            // late subscribers" branch: a late subscriber gets the fresh
            // chain (value, or a NEW B15 error on exhaustion) — the recovery
            // the original B15 comment promised remounts, now delivered on
            // every remount rather than only ones that re-called the
            // accessor. Current subscribers still see failures via the hot
            // B15 push above.
            failures.delete(key);
            runFetchSWR(key);
          } else if (rehydrated.has(key)) {
            // B18 — first observation of a restored-from-disk value: serve it
            // immediately (it is already in the store, so subscribers paint
            // with no `undefined` flash — B17's actual win is preserved) AND
            // revalidate in the background, rendering the fresher on arrival.
            // `runFetch` clears the mark, so this costs at most one
            // revalidation CHAIN per rehydrated key per session — one
            // request, plus B14's single bounded retry if it fails;
            // thereafter B2 applies as usual. A failed chain keeps the
            // persisted value visible (B6) — never worse than not
            // revalidating at all.
            runFetchSWR(key);
          } else if (!store$.value.has(key) && !inflight.has(key)) {
            // Subscribe path: fire-and-forget, swallow failures so a
            // subscriber stays at its last value (B6); one bounded retry
            // (B14). The awaiter's `fetch` surfaces failures instead.
            runFetchSWR(key);
          }
          return inner.subscribe(subscriber);
        });
        obsCache.set(key, obs);
      }
      return obs;
    },

    fetch(key: K): Promise<V> {
      // B16: surfaced, not silent — the await path's caller owns retry
      // policy (B14 boundary 1), so it gets a rejection it can see.
      if (disposed) return Promise.reject(new Error('Cache disposed'));
      return runFetch(key);
    },

    get(key: K): V | undefined {
      return store$.value.get(key);
    },

    keys(): K[] {
      return [...store$.value.keys()];
    },

    invalidate(key: K): void {
      if (disposed) return; // B16
      // B7: do NOT erase the value. Clear the guard (B9 orphan recovery)
      // and the B15 failure marker, then trigger a fresh fetch (with the
      // B14 bounded retry). Observers keep seeing the stale value until the
      // new value replaces it.
      inflight.delete(key);
      failures.delete(key);
      runFetchSWR(key);
    },

    remove(key: K): void {
      if (disposed) return; // B16
      rehydrated.delete(key); // B18: nothing left to revalidate
      // B13a: drop the entry. The value is gone; observers see `undefined`.
      const next = new Map(store$.value);
      next.delete(key);
      store$.next(next);
      inflight.delete(key);
      failures.delete(key);
    },

    set(key: K, value: V): void {
      if (disposed) return; // B16
      // B13b: write-through. No fetch. Atomic update. A written value
      // supersedes any B15 failure marker — and any B18 rehydrated mark:
      // a caller-supplied value is current by construction.
      failures.delete(key);
      rehydrated.delete(key);
      const next = new Map(store$.value);
      next.set(key, value);
      store$.next(next);
    },

    invalidateAll(): void {
      if (disposed) return; // B16
      // Per-key SWR refetch of every currently-cached entry. Each entry
      // keeps its stale value until its refetch resolves.
      for (const key of store$.value.keys()) {
        inflight.delete(key);
        runFetchSWR(key);
      }
    },

    persistencePending(): boolean {
      // B17-Q: in-flight fetches mean content may still be older than the
      // event that triggered them; a pending debounced save means content
      // newer than the persisted document. Either way the bookmark must wait.
      return inflight.size > 0 || saveTimer !== null;
    },

    dispose(): void {
      if (disposed) return; // idempotent (B16)
      disposed = true;
      // B17: flush a pending save before the store completes — the disposal
      // act itself, not a post-disposal act.
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
        trySave(store$.value);
      }
      unsubscribeExternal?.();
      rehydrated.clear(); // B18
      store$.complete();
      // Must complete alongside store$: the per-key observable is a merge,
      // and merge completes only when ALL its sources complete — leaving
      // failure$ open would keep every observer's subscription alive.
      failure$.complete();
      failures.clear();
      obsCache.clear();
      inflight.clear();
    },
  };
}
