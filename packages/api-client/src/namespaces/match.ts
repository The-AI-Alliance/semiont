import { Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { ResourceId, GatheredContext, EventBus } from '@semiont/core';
import type { ActorVM } from '../view-models/domain/actor-vm';
import type { MatchNamespace as IMatchNamespace, MatchSearchProgress } from './types';

export class MatchNamespace implements IMatchNamespace {
  constructor(
    private readonly eventBus: EventBus,
    private readonly actor: ActorVM,
  ) {}

  search(
    resourceId: ResourceId,
    referenceId: string,
    context: GatheredContext,
    options?: { limit?: number; useSemanticScoring?: boolean },
  ): Observable<MatchSearchProgress> {
    return new Observable((subscriber) => {
      const correlationId = crypto.randomUUID();

      const result$ = this.eventBus.get('match:search-results').pipe(
        filter((e) => e.correlationId === correlationId),
      );
      const failed$ = this.eventBus.get('match:search-failed').pipe(
        filter((e) => e.correlationId === correlationId),
      );

      const resultSub = result$.subscribe((e) => {
        subscriber.next(e as MatchSearchProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.error));
      });

      this.actor.emit('match:search-requested', {
        correlationId,
        resourceId,
        referenceId,
        context: context as unknown as Record<string, unknown>,
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
