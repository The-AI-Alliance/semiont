import { type Observable, map } from 'rxjs';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import type { StateUnit } from '@semiont/sdk';
import type { SemiontClient } from '@semiont/sdk';

export interface ResourceLoaderStateUnit extends StateUnit {
  resource$: Observable<ResourceDescriptor | undefined>;
  isLoading$: Observable<boolean>;
  invalidate(): void;
}

export function createResourceLoaderStateUnit(
  client: SemiontClient,
  resourceId: ResourceId,
): ResourceLoaderStateUnit {
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
