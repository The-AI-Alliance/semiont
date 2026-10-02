import type { Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '@semiont/core';

export interface MatchStateUnit extends StateUnit {}

export function createMatchStateUnit(client: SemiontClient): MatchStateUnit {
  const subs: Subscription[] = [];

  subs.push(client.bus.frames('match:search-requested').subscribe(({ payload: event, correlationId }) => {
    const searchSub = client.match.search(
      event.resourceId,
      event.referenceId,
      event.context,
      { limit: event.limit, useSemanticScoring: event.useSemanticScoring },
    ).pipe(
      timeout(60_000),
    ).subscribe({
      next: (result) => client.bus.emit('match:search-results', result, { correlationId }),
      error: (err) => client.bus.emit('match:search-failed', { referenceId: event.referenceId,
        error: err instanceof Error ? err.message : String(err), }, { correlationId }),
    });
    subs.push(searchSub);
  }));

  return {
    dispose() {
      subs.forEach(s => s.unsubscribe());
    },
  };
}
