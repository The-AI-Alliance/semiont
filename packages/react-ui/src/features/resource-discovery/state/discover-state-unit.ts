import { BehaviorSubject, Subject, combineLatest, of, type Observable } from 'rxjs';
import { debounceTime, distinctUntilChanged, map, startWith, switchMap, shareReplay } from 'rxjs/operators';
import type { ResourceDescriptor } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import { createDisposer } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import { trackList, type ListState } from '../../../state/list-state';

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
  recent: ListState<ResourceDescriptor[]>;
  entityTypes: ListState<string[]>;
  selectedEntityType$: Observable<string>;
  setSelectedEntityType(value: string): void;
}

export function createDiscoverStateUnit(
  client: SemiontClient,
  browse: ShellStateUnit,
): DiscoverStateUnit {
  const disposer = createDisposer();
  // `browse` (ShellStateUnit) is a *passed-in* dependency owned by the caller
  // (`useShellStateUnit`), not this unit — do NOT add it to the disposer (it's the
  // shared, app-scoped shell). See packages/sdk/docs/STATE-UNITS.md (composition rule).

  // Selected entity-type chip on the Discover page. Drives both the
  // `recent` list and the search results — filtering happens on the
  // backend, not via post-fetch array filtering.
  const selectedEntityType$ = new BehaviorSubject<string>('');
  disposer.add(() => selectedEntityType$.complete());

  const queryInput$ = new Subject<string>();
  disposer.add(() => queryInput$.complete());

  // `trackList` holds the single subscription and multicasts through its own
  // subjects, so the previous `shareReplay` is unnecessary — and it would have
  // been actively wrong here: a replayed ERROR cannot be retried away, and
  // retry must reach `browse.resources()` again for B15 to clear the marker.
  // The thunk therefore rebuilds the whole chain per attempt.
  const recent = trackList<ResourceDescriptor[]>(
    () => selectedEntityType$.pipe(
      switchMap((et) =>
        client.browse.resources({
          limit: RECENT_LIMIT,
          archived: false,
          ...(et ? { entityType: et } : {}),
        }),
      ),
    ),
    [],
  );
  disposer.add(recent.dispose);

  const entityTypes = trackList<string[]>(() => client.browse.entityTypes(), []);
  disposer.add(entityTypes.dispose);

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
    recent: recent.state,
    entityTypes: entityTypes.state,
    selectedEntityType$: selectedEntityType$.asObservable(),
    setSelectedEntityType: (value) => selectedEntityType$.next(value),
    dispose: () => disposer.dispose(),
  };
}
