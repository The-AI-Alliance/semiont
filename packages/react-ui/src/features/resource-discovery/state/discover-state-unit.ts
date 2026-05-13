import { BehaviorSubject, Subject, combineLatest, of, type Observable } from 'rxjs';
import { debounceTime, distinctUntilChanged, map, startWith, switchMap, shareReplay } from 'rxjs/operators';
import type { ResourceDescriptor } from '@semiont/core';
import type { SemiontClient, StateUnit } from '@semiont/sdk';
import { createDisposer } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../state/shell-state-unit';

const RECENT_LIMIT = 10;
const SEARCH_LIMIT = 20;
const DEBOUNCE_MS = 250;

export interface DiscoverSearchPipeline {
  query$: Observable<string>;
  state$: Observable<{ results: ResourceDescriptor[]; isSearching: boolean }>;
  setQuery(value: string): void;
}

export interface DiscoverStateUnit extends StateUnit {
  browse: ShellStateUnit;
  search: DiscoverSearchPipeline;
  recentResources$: Observable<ResourceDescriptor[]>;
  entityTypes$: Observable<string[]>;
  isLoadingRecent$: Observable<boolean>;
  selectedEntityType$: Observable<string>;
  setSelectedEntityType(value: string): void;
}

export function createDiscoverStateUnit(
  client: SemiontClient,
  browse: ShellStateUnit,
): DiscoverStateUnit {
  const disposer = createDisposer();
  disposer.add(browse);

  // Selected entity-type chip on the Discover page. Drives both the
  // `recent` list and the search results — filtering happens on the
  // backend, not via post-fetch array filtering.
  const selectedEntityType$ = new BehaviorSubject<string>('');
  disposer.add(() => selectedEntityType$.complete());

  const queryInput$ = new Subject<string>();
  disposer.add(() => queryInput$.complete());

  const recent$ = selectedEntityType$.pipe(
    switchMap((et) =>
      client.browse.resources({
        limit: RECENT_LIMIT,
        archived: false,
        ...(et ? { entityType: et } : {}),
      }),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  const recentResources$: Observable<ResourceDescriptor[]> = recent$.pipe(
    map((r) => r ?? []),
  );

  const isLoadingRecent$: Observable<boolean> = recent$.pipe(
    map((r) => r === undefined),
  );

  const entityTypes$: Observable<string[]> = client.browse.entityTypes().pipe(
    map((e) => e ?? []),
  );

  const debouncedQuery$ = queryInput$.pipe(
    startWith(''),
    debounceTime(DEBOUNCE_MS),
    distinctUntilChanged(),
  );

  const state$: Observable<{ results: ResourceDescriptor[]; isSearching: boolean }> =
    combineLatest([debouncedQuery$, selectedEntityType$]).pipe(
      switchMap(([q, et]) => {
        const trimmed = q.trim();
        if (!trimmed) {
          return of({ results: [] as ResourceDescriptor[], isSearching: false });
        }
        return client.browse
          .resources({
            search: trimmed,
            limit: SEARCH_LIMIT,
            ...(et ? { entityType: et } : {}),
          })
          .pipe(
            map((results) => ({
              results: results ?? [],
              isSearching: results === undefined,
            })),
            startWith({ results: [] as ResourceDescriptor[], isSearching: true }),
          );
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

  const search: DiscoverSearchPipeline = {
    query$: queryInput$.pipe(startWith('')),
    state$,
    setQuery: (value) => queryInput$.next(value),
  };

  return {
    browse,
    search,
    recentResources$,
    entityTypes$,
    isLoadingRecent$,
    selectedEntityType$: selectedEntityType$.asObservable(),
    setSelectedEntityType: (value) => selectedEntityType$.next(value),
    dispose: () => disposer.dispose(),
  };
}
