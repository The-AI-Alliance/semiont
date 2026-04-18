import { Observable, merge } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';
import type { AnnotationId, ResourceId, EventBus } from '@semiont/core';
import type { ActorVM } from '../view-models/domain/actor-vm';
import type { GatherNamespace as IGatherNamespace, GatherAnnotationProgress } from './types';

export class GatherNamespace implements IGatherNamespace {
  constructor(
    private readonly eventBus: EventBus,
    private readonly actor: ActorVM,
  ) {}

  annotation(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    options?: { contextWindow?: number },
  ): Observable<GatherAnnotationProgress> {
    return new Observable((subscriber) => {
      const correlationId = crypto.randomUUID();

      const complete$ = this.eventBus.get('gather:complete').pipe(
        filter((e) => e.correlationId === correlationId),
      );
      const failed$ = this.eventBus.get('gather:failed').pipe(
        filter((e) => e.correlationId === correlationId),
      );

      const sub = merge(
        this.eventBus.get('gather:annotation-progress').pipe(
          filter((e) => (e as { annotationId?: string }).annotationId === (annotationId as string)),
          map((e) => e as GatherAnnotationProgress),
        ),
        complete$.pipe(map((e) => e as GatherAnnotationProgress)),
      )
        .pipe(takeUntil(merge(complete$, failed$)))
        .subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => subscriber.error(e),
        });

      const completeSub = complete$.subscribe((e) => {
        subscriber.next(e as GatherAnnotationProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.message));
      });

      this.actor.emit('gather:requested', {
        correlationId,
        annotationId,
        resourceId,
        contextWindow: options?.contextWindow ?? 2000,
      }).catch((error) => {
        subscriber.error(error);
      });

      return () => {
        sub.unsubscribe();
        completeSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  resource(
    _resourceId: ResourceId,
    _options?: { contextWindow?: number },
  ): Observable<GatherAnnotationProgress> {
    throw new Error('Not implemented: gather.resource() — no backend route yet');
  }
}
