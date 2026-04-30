import type { Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { ResourceId, GatheredContext } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '../lib/state-unit';

export interface MatchStateUnit extends StateUnit {}

export function createMatchStateUnit(
  client: SemiontClient,
  _resourceId: ResourceId,
): MatchStateUnit {
  const subs: Subscription[] = [];

  subs.push(client.bus.get('match:search-requested').subscribe((event) => {
    const searchSub = client.match.search(
      makeResourceId(event.resourceId),
      makeAnnotationId(event.referenceId),
      event.context as GatheredContext,
      { limit: event.limit, useSemanticScoring: event.useSemanticScoring },
    ).pipe(
      timeout(60_000),
    ).subscribe({
      next: (result) => client.bus.get('match:search-results').next(result),
      error: (err) => client.bus.get('match:search-failed').next({
        correlationId: event.correlationId,
        referenceId: event.referenceId,
        error: err instanceof Error ? err.message : String(err),
      }),
    });
    subs.push(searchSub);
  }));

  return {
    dispose() {
      subs.forEach(s => s.unsubscribe());
    },
  };
}
