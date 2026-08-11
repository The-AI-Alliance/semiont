import { BehaviorSubject, Subject, combineLatest, of, type Observable } from 'rxjs';
import { readyValue, type CacheState } from '@semiont/sdk';
import { debounceTime, distinctUntilChanged, map, startWith, switchMap, shareReplay } from 'rxjs/operators';
import type { ResourceDescriptor } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import { createDisposer } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import { trackList, type ListState } from '../../../state/list-state';

const RECENT_LIMIT = 10;
const SEARCH_LIMIT = 20;
const DEBOUNCE_MS = 250;

export interface DiscoverSearchPipeline {
  query$: Observable<string>;
  /**
   * The page AND the label that describes it, as one value. `matchKind` is
   * carried here rather than beside it because SEMANTIC-FALLBACK S10 is
   * tier-agnostic: two separately-observable pieces of state let a render pair
   * this query's label with the previous query's list. Undefined only before
   * the first answer (and while a query is empty), never as a third kind.
   */
  state$: Observable<{
    results: ResourceDescriptor[];
    isSearching: boolean;
    matchKind?: 'lexical' | 'semantic';
  }>;
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
  session: SemiontSession,
  browse: ShellStateUnit,
): DiscoverStateUnit {
  const { client } = session;
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
        }).pipe(
          // This unit renders only the page; project it out of the list
          // envelope (`matchKind` rendering is SEMANTIC-FALLBACK P3b's).
          map((st): CacheState<ResourceDescriptor[]> => (st.status === 'ready' ? { status: 'ready', value: st.value.resources } : st)),
        ),
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

  const state$: DiscoverSearchPipeline['state$'] =
    combineLatest([debouncedQuery$, selectedEntityType$]).pipe(
      switchMap(([q, et]) => {
        const trimmed = q.trim();
        if (!trimmed) {
          // No query, no answer to label: `recent` is what renders, and no
          // matchKind describes it.
          return of({ results: [] as ResourceDescriptor[], isSearching: false });
        }
        return client.browse
          .resources({
            search: trimmed,
            limit: SEARCH_LIMIT,
            ...(et ? { entityType: et } : {}),
          })
          .pipe(
            map((st) => {
              const ready = readyValue(st);
              return {
                results: ready?.resources ?? [],
                isSearching: st.status === 'pending',
                ...(ready ? { matchKind: ready.matchKind } : {}),
              };
            }),
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
