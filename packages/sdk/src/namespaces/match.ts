import { Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ResourceId, GatheredContext, EventBus, components } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import type { MatchNamespace as IMatchNamespace, MatchSearchProgress } from './types';

export class MatchNamespace implements IMatchNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  requestSearch(input: components['schemas']['MatchSearchRequest']): void {
    // Local emit: match-vm subscribes via the local bus.
    this.bus.get('match:search-requested').next(input);
  }

  search(
    resourceId: ResourceId,
    referenceId: string,
    context: GatheredContext,
    options?: { limit?: number; useSemanticScoring?: boolean },
  ): Observable<MatchSearchProgress> {
    return new Observable((subscriber) => {
      const correlationId = crypto.randomUUID();

      const result$ = this.bus.get('match:search-results').pipe(
        filter((e) => e.correlationId === correlationId),
      );
      const failed$ = this.bus.get('match:search-failed').pipe(
        filter((e) => e.correlationId === correlationId),
      );

      const resultSub = result$.subscribe((e) => {
        subscriber.next(e as MatchSearchProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.error));
      });

      this.transport.emit('match:search-requested', {
        correlationId,
        resourceId,
        referenceId,
        context,
        limit: options?.limit ?? 10,
        useSemanticScoring: options?.useSemanticScoring ?? true,
      }).catch((error) => {
        subscriber.error(error);
      });

      return () => {
        resultSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }
}
