import { filter, map} from 'rxjs/operators';
import type { AnnotationId, ResourceId, GatheredContext, EventBus, components } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { uuidV4 } from '@semiont/core';
import { StreamObservable } from '../awaitable';
import type { MatchNamespace as IMatchNamespace, MatchSearchProgress } from './types';

export class MatchNamespace implements IMatchNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  requestSearch(input: components['schemas']['MatchSearchRequest'], correlationId: string): void {
    // Local emit: match-state-unit subscribes via the local bus. The key is
    // the caller's to mint and rides the envelope, never the request body.
    this.bus.emit('match:search-requested', input, { correlationId });
  }

  search(
    resourceId: ResourceId,
    referenceId: AnnotationId,
    context: GatheredContext,
    options?: { limit?: number; useSemanticScoring?: boolean },
  ): StreamObservable<MatchSearchProgress> {
    return new StreamObservable<MatchSearchProgress>((subscriber) => {
      const correlationId = uuidV4();

      const result$ = this.bus.frames('match:search-results').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );
      const failed$ = this.bus.frames('match:search-failed').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );

      const resultSub = result$.subscribe((e) => {
        subscriber.next(e as MatchSearchProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.error));
      });

      this.transport.emit('match:search-requested', { resourceId,
        referenceId,
        context,
        limit: options?.limit ?? 10,
        useSemanticScoring: options?.useSemanticScoring ?? true, }, { correlationId }).catch((error) => {
        // Don't propagate if a result or failure event already closed the
        // subscriber, or if the consumer disposed mid-flight. Otherwise
        // RxJS hosts the error as an uncaught exception.
        if (subscriber.closed) return;
        subscriber.error(error);
      });

      return () => {
        resultSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }
}
