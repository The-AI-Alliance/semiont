import { merge } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';
import type { AnnotationId, ResourceId, EventBus } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { StreamObservable } from '../awaitable';
import type { GatherNamespace as IGatherNamespace, GatherAnnotationProgress } from './types';

export class GatherNamespace implements IGatherNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  annotation(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    options?: { contextWindow?: number },
  ): StreamObservable<GatherAnnotationProgress> {
    return new StreamObservable<GatherAnnotationProgress>((subscriber) => {
      const correlationId = crypto.randomUUID();

      const complete$ = this.bus.get('gather:complete').pipe(
        filter((e) => e.correlationId === correlationId),
      );
      const failed$ = this.bus.get('gather:failed').pipe(
        filter((e) => e.correlationId === correlationId),
      );

      const sub = merge(
        this.bus.get('gather:annotation-progress').pipe(
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

      this.transport.emit('gather:requested', {
        correlationId,
        annotationId,
        resourceId,
        options: { contextWindow: options?.contextWindow ?? 2000 },
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
  ): StreamObservable<GatherAnnotationProgress> {
    throw new Error('Not implemented: gather.resource() — no backend route yet');
  }
}
