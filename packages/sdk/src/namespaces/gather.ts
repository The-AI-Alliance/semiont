import { filter, map } from 'rxjs/operators';
import type { AnnotationId, ResourceId, EventBus, GatheredContext } from '@semiont/core';
import type { ITransport } from '@semiont/core';
import { StreamObservable } from '../awaitable';
import { busRequest, uuidV4 } from '@semiont/core';
import type { GatherNamespace as IGatherNamespace, GatherAnnotationComplete } from './types';

export class GatherNamespace implements IGatherNamespace {
  constructor(
    private readonly transport: ITransport,
    private readonly bus: EventBus,
  ) {}

  annotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    options?: { contextWindow?: number },
  ): StreamObservable<GatherAnnotationComplete> {
    return new StreamObservable<GatherAnnotationComplete>((subscriber) => {
      const correlationId = uuidV4();

      const complete$ = this.bus.frames('gather:complete').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );
      const failed$ = this.bus.frames('gather:failed').pipe(
        filter((frame) => frame.correlationId === correlationId),
        map((frame) => frame.payload),
      );

      const completeSub = complete$.subscribe((e) => {
        subscriber.next(e);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.message));
      });

      this.transport.emit('gather:requested', {
        annotationId,
        resourceId,
        options: { contextWindow: options?.contextWindow ?? 2000 },
      }, { correlationId }).catch((error) => {
        // Don't propagate if a result or failure event already closed the
        // subscriber, or if the consumer disposed mid-flight. Otherwise
        // RxJS hosts the error as an uncaught exception.
        if (subscriber.closed) return;
        subscriber.error(error);
      });

      return () => {
        completeSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  /**
   * Gather whole-resource LLM context — a request/reply over
   * `gather:resource-requested` → `gather:resource-complete`/`-failed`, shaped
   * as a `Promise` rather than the `StreamObservable` `annotation()` returns. Resolves to the unified `GatheredContext` (focus.kind:
   * 'resource') the gateway assembled — the resource focus plus the shared
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
    return busRequest(
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
    );
  }
}
