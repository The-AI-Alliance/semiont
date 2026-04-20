import type { Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { ResourceId, GatheredContext } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface MatchVM extends ViewModel {}

export function createMatchVM(
  client: SemiontApiClient,
  _resourceId: ResourceId,
): MatchVM {
  const subs: Subscription[] = [];

  subs.push(client.stream('match:search-requested').subscribe((event) => {
    const searchSub = client.match.search(
      makeResourceId(event.resourceId),
      event.referenceId,
      event.context as GatheredContext,
      { limit: event.limit, useSemanticScoring: event.useSemanticScoring },
    ).pipe(
      timeout(60_000),
    ).subscribe({
      next: (result) => client.emit('match:search-results', result),
      error: (err) => client.emit('match:search-failed', {
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
