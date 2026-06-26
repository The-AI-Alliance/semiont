import { merge } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';
import type { AnnotationId, ResourceId, EventBus, GatheredContext } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { StreamObservable } from '../awaitable';
import { busRequest } from '../bus-request';
import type { GatherNamespace as IGatherNamespace, GatherAnnotationProgress } from './types';

export class GatherNamespace implements IGatherNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  annotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
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
        // Don't propagate if a result or failure event already closed the
        // subscriber, or if the consumer disposed mid-flight. Otherwise
        // RxJS hosts the error as an uncaught exception.
        if (subscriber.closed) return;
        subscriber.error(error);
      });

      return () => {
        sub.unsubscribe();
        completeSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  /**
   * Gather whole-resource LLM context — a request/reply over
   * `gather:resource-requested` → `gather:resource-complete`/`-failed`. Unlike
   * `annotation()` there are no progress events, so this is a `Promise`, not a
   * `StreamObservable`. Resolves to the unified `GatheredContext` (focus.kind:
   * 'resource') the backend assembled — the resource focus plus the shared
   * knowledge graph; rejects with a `BusRequestError` on failure. Defaults mirror
   * the CLI `gather` command (depth 2, maxResources 10, content in, summary out).
   */
  resource(
    resourceId: ResourceId,
    options?: {
      depth?: number;
      maxResources?: number;
      includeContent?: boolean;
      includeSummary?: boolean;
      /** Entity types to exclude from the semantic recall built into the context
       *  (e.g. ['Question'] so prior questions never ground answer generation). */
      excludeEntityTypes?: string[];
    },
  ): Promise<GatheredContext> {
    return busRequest<GatheredContext>(
      this.transport,
      'gather:resource-requested',
      {
        resourceId,
        options: {
          depth: options?.depth ?? 2,
          maxResources: options?.maxResources ?? 10,
          includeContent: options?.includeContent ?? true,
          includeSummary: options?.includeSummary ?? false,
          ...(options?.excludeEntityTypes?.length ? { excludeEntityTypes: options.excludeEntityTypes } : {}),
        },
      },
      'gather:resource-complete',
      'gather:resource-failed',
    );
  }
}
