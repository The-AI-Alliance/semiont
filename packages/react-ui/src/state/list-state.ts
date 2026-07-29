import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';

/**
 * A cache-backed list in its real states.
 *
 * `loading$` is true only until THIS subscription's first value; once a value
 * has arrived it never re-enters — even `retry()` routes through
 * `revalidating$` then — so a blocking spinner keyed on it structurally
 * cannot latch over rendered rows. The one deliberate exception is BEFORE any
 * value: `retry()` on a never-loaded list returns to the blocking state,
 * because there is nothing to render behind a non-blocking indicator.
 * `revalidating$` is the non-blocking sibling: the thunk's chain has moved to
 * a cache key that is not resolved yet (the cache emits `undefined` for it)
 * while `value$` still holds the previous key's rows. Views keep rendering the
 * stale list; a subtle indicator is optional.
 *
 * Why two signals instead of routing a late `undefined` back into `loading$`:
 * a stable cache key can never go value→undefined (`invalidate()` keeps the
 * value per B7; `remove()` is not used on list caches), so a late `undefined`
 * only ever means "new key, fetch in flight". Treating that as blocking
 * turns a routine filter switch into a full-page spinner — and if the fetch
 * is lost, into a spinner that never resolves. The failure path stays B14 →
 * B15 → `error$`, which views check before either signal.
 * See .plans/PANEL-FAILURE-STATES.md
 */
export interface ListState<T> {
  value$: Observable<T>;
  /**
   * True until the first value. Never re-enters after one — a `retry()`
   * before any value (nothing to render) is the sole way back in.
   */
  loading$: Observable<boolean>;
  /** True while a NEW key's fetch is pending behind a stale `value$`. */
  revalidating$: Observable<boolean>;
  error$: Observable<Error | null>;
  /** Re-subscribe: B15 clears the failure marker on a fresh `observe()`. */
  retry(): void;
}

/**
 * Track one cache-backed query as a `ListState`.
 *
 * `open` is a THUNK, not an observable: an errored observable is terminated,
 * and calling `browse.x()` again is what re-enters `observe()` — which is
 * where the cache clears the B15 marker and starts a fresh attempt chain.
 * Same reason `createResourceLoaderStateUnit` re-`attach()`es.
 *
 * Returns the state plus its own `dispose`; the owning state unit is expected
 * to register that with its disposer.
 */
export function trackList<T>(open: () => Observable<T | undefined>, empty: T): {
  state: ListState<T>;
  dispose: () => void;
} {
  const value$ = new BehaviorSubject<T>(empty);
  const loading$ = new BehaviorSubject<boolean>(true);
  const revalidating$ = new BehaviorSubject<boolean>(false);
  const error$ = new BehaviorSubject<Error | null>(null);

  /** A real value has arrived at least once — `value$` is meaningful. */
  let hasValue = false;
  let subscription: Subscription | null = null;
  let disposed = false;

  const attach = (): void => {
    if (disposed) return;
    subscription?.unsubscribe();
    subscription = open().subscribe({
      next: (value) => {
        if (error$.getValue() !== null) error$.next(null);
        // The cache emits `undefined` for a key it has not resolved yet.
        // Before the first value that IS the loading state (already true);
        // after one, it can only mean the chain switched to a new key —
        // revalidate behind the stale value rather than blocking.
        if (value === undefined) {
          if (hasValue && !revalidating$.getValue()) revalidating$.next(true);
          return;
        }
        hasValue = true;
        value$.next(value);
        if (loading$.getValue()) loading$.next(false);
        if (revalidating$.getValue()) revalidating$.next(false);
      },
      error: (e: unknown) => {
        error$.next(e instanceof Error ? e : new Error(String(e)));
        if (loading$.getValue()) loading$.next(false);
        if (revalidating$.getValue()) revalidating$.next(false);
      },
    });
  };
  attach();

  return {
    state: {
      // X1: owned subjects are published read-only.
      value$: value$.asObservable(),
      loading$: loading$.asObservable(),
      revalidating$: revalidating$.asObservable(),
      error$: error$.asObservable(),
      retry: () => {
        if (disposed) return;
        error$.next(null);
        // With a stale value to show, a retry is a revalidation; only a
        // never-loaded list goes back to the blocking state.
        if (hasValue) revalidating$.next(true);
        else loading$.next(true);
        attach();
      },
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscription?.unsubscribe();
      subscription = null;
      value$.complete();
      loading$.complete();
      revalidating$.complete();
      error$.complete();
    },
  };
}
