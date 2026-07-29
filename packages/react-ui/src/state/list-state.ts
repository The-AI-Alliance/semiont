import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';

/**
 * A cache-backed list in its three real states.
 *
 * `loading` is NOT "the value is undefined": `browse.*()` delivers a terminal
 * failure as an RxJS error (B15) once B14's retry is exhausted with nothing
 * stored, and a key that failed has no value either — so a two-state model
 * reports a dead request as an eternal spinner and drops the reason. `value$`
 * still carries an empty list through a failure, so a view can render its
 * frame either way.
 * See .plans/PANEL-FAILURE-STATES.md
 */
export interface ListState<T> {
  value$: Observable<T>;
  loading$: Observable<boolean>;
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
  const error$ = new BehaviorSubject<Error | null>(null);

  let subscription: Subscription | null = null;
  let disposed = false;

  const attach = (): void => {
    if (disposed) return;
    subscription?.unsubscribe();
    subscription = open().subscribe({
      next: (value) => {
        if (error$.getValue() !== null) error$.next(null);
        // The cache emits `undefined` for a key it has not resolved yet — the
        // loading state, not a value. It can arrive AFTER a value, too: a
        // thunk whose chain `switchMap`s to a new cache key emits `undefined`
        // for that key first (discover does exactly this when the entity-type
        // filter changes). Re-entering loading is what keeps the pair honest;
        // otherwise the previous key's rows read as current while a request
        // is still in flight. `value$` deliberately keeps the last value, so a
        // view can render stale-with-spinner rather than flashing empty.
        if (value === undefined) {
          if (!loading$.getValue()) loading$.next(true);
          return;
        }
        value$.next(value);
        if (loading$.getValue()) loading$.next(false);
      },
      error: (e: unknown) => {
        error$.next(e instanceof Error ? e : new Error(String(e)));
        if (loading$.getValue()) loading$.next(false);
      },
    });
  };
  attach();

  return {
    state: {
      // X1: owned subjects are published read-only.
      value$: value$.asObservable(),
      loading$: loading$.asObservable(),
      error$: error$.asObservable(),
      retry: () => {
        if (disposed) return;
        error$.next(null);
        loading$.next(true);
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
      error$.complete();
    },
  };
}
