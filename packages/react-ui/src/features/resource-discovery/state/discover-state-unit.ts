import { map, type Observable } from 'rxjs';
import type { ResourceDescriptor } from '@semiont/core';
import type { StateUnit } from '@semiont/sdk';
import { createDisposer } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import { createSearchPipeline, type SearchPipeline } from '@semiont/sdk';
import type { SemiontClient } from '@semiont/sdk';

const RECENT_LIMIT = 10;
const SEARCH_LIMIT = 20;

export interface DiscoverStateUnit extends StateUnit {
  browse: ShellStateUnit;
  search: SearchPipeline<ResourceDescriptor>;
  recentResources$: Observable<ResourceDescriptor[]>;
  entityTypes$: Observable<string[]>;
  isLoadingRecent$: Observable<boolean>;
}

export function createDiscoverStateUnit(
  client: SemiontClient,
  browse: ShellStateUnit,
): DiscoverStateUnit {
  const disposer = createDisposer();

  const search = createSearchPipeline<ResourceDescriptor>((q) =>
    client.browse.resources({ search: q, limit: SEARCH_LIMIT }),
  );
  disposer.add(search);
  disposer.add(browse);

  const recent$ = client.browse.resources({ limit: RECENT_LIMIT, archived: false });

  const recentResources$: Observable<ResourceDescriptor[]> = recent$.pipe(
    map((r) => r ?? []),
  );

  const isLoadingRecent$: Observable<boolean> = recent$.pipe(
    map((r) => r === undefined),
  );

  const entityTypes$: Observable<string[]> = client.browse.entityTypes().pipe(
    map((e) => e ?? []),
  );

  return {
    browse,
    search,
    recentResources$,
    entityTypes$,
    isLoadingRecent$,
    dispose: () => disposer.dispose(),
  };
}
