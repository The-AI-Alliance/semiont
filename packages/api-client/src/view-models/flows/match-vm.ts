import type { Subscription } from 'rxjs';
import type { EventBus, ResourceId, GatheredContext } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface MatchVM extends ViewModel {}

export function createMatchVM(
  client: SemiontApiClient,
  eventBus: EventBus,
  _resourceId: ResourceId,
): MatchVM {
  const subs: Subscription[] = [];

  subs.push(eventBus.get('match:search-requested').subscribe((event) => {
    const searchSub = client.match.search(
      makeResourceId(event.resourceId),
      event.referenceId,
      event.context as GatheredContext,
      { limit: event.limit, useSemanticScoring: event.useSemanticScoring },
    ).subscribe({
      next: (result) => eventBus.get('match:search-results').next(result),
      error: (err) => eventBus.get('match:search-failed').next({
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
