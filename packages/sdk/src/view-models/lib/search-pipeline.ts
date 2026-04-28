/**
 * createSearchPipeline
 *
 * A debounced-search RxJS pipeline factory. Combines an input Subject with a
 * downstream fetch function and emits typed `{ results, isSearching }` state.
 *
 * Designed to be created once per consumer instance and held for its lifetime
 * (e.g. by a view layer's lazy initializer), then observed via `state$`. The
 * pipeline is pure RxJS — unit-testable without any view-layer dependency.
 *
 * The fetch function is expected to return `Observable<T[] | undefined>`,
 * matching the cache-miss-then-data shape of `BrowseNamespace` Observables:
 * `undefined` means "fetch in flight, no value yet"; an array means "data
 * available (possibly empty)".
 */

import { Subject, of, type Observable } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, startWith, map } from 'rxjs/operators';

export interface SearchState<T> {
  results: T[];
  isSearching: boolean;
}

export interface SearchPipeline<T> {
  /** Latest query string. Bind to a controlled input. */
  query$: Observable<string>;
  /** Latest search state — results plus a loading flag. */
  state$: Observable<SearchState<T>>;
  /** Push a new query value. Triggers the debounced fetch. */
  setQuery(value: string): void;
  /** Tear down the input Subject. Call from the consumer's cleanup hook. */
  dispose(): void;
}

export interface SearchPipelineOptions {
  /** Milliseconds to wait after the last keystroke before fetching. Default 250. */
  debounceMs?: number;
  /** Initial query value. Useful for modals that open with a pre-filled term. */
  initialQuery?: string;
}

export function createSearchPipeline<T>(
  fetch: (query: string) => Observable<T[] | undefined>,
  options: SearchPipelineOptions = {},
): SearchPipeline<T> {
  const debounceMs = options.debounceMs ?? 250;
  const initial = options.initialQuery ?? '';
  const input$ = new Subject<string>();

  const query$: Observable<string> = input$.pipe(startWith(initial));

  const state$: Observable<SearchState<T>> = input$.pipe(
    startWith(initial),
    debounceTime(debounceMs),
    distinctUntilChanged(),
    switchMap((q): Observable<SearchState<T>> => {
      const trimmed = q.trim();
      if (!trimmed) {
        return of({ results: [], isSearching: false });
      }
      return fetch(trimmed).pipe(
        map((results): SearchState<T> => ({
          results: results ?? [],
          isSearching: results === undefined,
        })),
        startWith({ results: [], isSearching: true } as SearchState<T>),
      );
    }),
  );

  return {
    query$,
    state$,
    setQuery: (value) => input$.next(value),
    dispose: () => input$.complete(),
  };
}
