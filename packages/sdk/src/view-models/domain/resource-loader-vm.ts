import { type Observable, map } from 'rxjs';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import type { ViewModel } from '../lib/view-model';
import type { SemiontClient } from '../../client';

export interface ResourceLoaderVM extends ViewModel {
  resource$: Observable<ResourceDescriptor | undefined>;
  isLoading$: Observable<boolean>;
  invalidate(): void;
}

export function createResourceLoaderVM(
  client: SemiontClient,
  resourceId: ResourceId,
): ResourceLoaderVM {
  const raw$ = client.browse.resource(resourceId);
  const resource$ = raw$;
  const isLoading$: Observable<boolean> = raw$.pipe(map((r) => r === undefined));

  return {
    resource$,
    isLoading$,
    invalidate: () => client.browse.invalidateResourceDetail(resourceId),
    dispose: () => {},
  };
}
