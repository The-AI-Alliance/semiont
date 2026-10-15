/**
 * createSearchPipeline
 *
 * A search as it is typed: a query, and the results of the query it last
 * settled on. Its meaning is the Rust SDK's `SearchPipeline`.
 *
 * The query is whatever was last set. Once it has stayed the same for the
 * debounce, it is searched for, unless it is the query already searched for.
 * A query of nothing but spaces searches for nothing and has no results. A new
 * query abandons the search before it. The query it begins with settles like
 * any other.
 *
 * Both are state: a reader is given the value now, and each value after it,
 * and every reader shares the one search. The pipeline works from the moment
 * it is made, and `dispose` ends it: the search in flight is abandoned, both
 * states end, and nothing it is told afterwards does anything.
 *
 * The fetch function is expected to return `Observable<T[] | undefined>`:
 * `undefined` means "fetch in flight, no value yet"; an array means "data
 * available (possibly empty)". A `BrowseNamespace` live query emits
 * `CacheState` values — adapt it with `map((st) => readyValue(st)?.resources)`
 * (or the equivalent projection), which collapses pending/failed to
 * `undefined`.
 */

import { SEARCH_DEBOUNCE_MS, type StateUnit } from '@semiont/core';
import { BehaviorSubject, of, type Observable } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, startWith, map } from 'rxjs/operators';

export interface SearchState<T> {
  results: T[];
  isSearching: boolean;
}

export interface SearchPipeline<T> extends StateUnit {
  /** The query as it was last set. Bind to a controlled input. */
  query$: Observable<string>;
  /** Latest search state — results plus a loading flag. */
  state$: Observable<SearchState<T>>;
  /** Set the query. A query it already has changes nothing. */
  setQuery(value: string): void;
}

export interface SearchPipelineOptions {
  /** Milliseconds to wait after the last keystroke before fetching. Default `SEARCH_DEBOUNCE_MS`. */
  debounceMs?: number;
  /** Initial query value. Useful for modals that open with a pre-filled term. */
  initialQuery?: string;
}

export function createSearchPipeline<T>(
  fetch: (query: string) => Observable<T[] | undefined>,
  options: SearchPipelineOptions = {},
): SearchPipeline<T> {
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const query$ = new BehaviorSubject<string>(options.initialQuery ?? '');
  const state$ = new BehaviorSubject<SearchState<T>>({ results: [], isSearching: false });

  const searching = query$.pipe(
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
  ).subscribe((state) => state$.next(state));

  return {
    query$: query$.asObservable(),
    state$: state$.asObservable(),
    setQuery: (value) => {
      if (value !== query$.value) query$.next(value);
    },
    dispose: () => {
      // Stopped before the query ends: an ending query would flush the debounce and search.
      searching.unsubscribe();
      query$.complete();
      state$.complete();
    },
  };
}
