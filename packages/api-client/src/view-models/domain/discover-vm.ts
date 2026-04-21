import { map, type Observable } from 'rxjs';
import type { components } from '@semiont/core';
import type { ViewModel } from '../lib/view-model';
import { createDisposer } from '../lib/view-model';
import type { ShellVM } from '../flows/shell-vm';
import { createSearchPipeline, type SearchPipeline } from '../lib/search-pipeline';
import type { SemiontApiClient } from '../../client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

const RECENT_LIMIT = 10;
const SEARCH_LIMIT = 20;

export interface DiscoverVM extends ViewModel {
  browse: ShellVM;
  search: SearchPipeline<ResourceDescriptor>;
  recentResources$: Observable<ResourceDescriptor[]>;
  entityTypes$: Observable<string[]>;
  isLoadingRecent$: Observable<boolean>;
}

export function createDiscoverVM(
  client: SemiontApiClient,
  browse: ShellVM,
): DiscoverVM {
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
