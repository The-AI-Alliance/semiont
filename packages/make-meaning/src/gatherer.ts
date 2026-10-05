/**
 * Gatherer Actor
 *
 * LLM context assembly for the Knowledge System. Subscribes to gather events,
 * queries KB stores via context modules, and emits results back to the bus
 * for the Generator and Linker Agents (docs/architecture/KNOWLEDGE-SYSTEM.md).
 *
 * Handles:
 * - gather:requested — annotation-level LLM context assembly
 * - gather:resource-requested — resource-level LLM context assembly
 * - gather:limits-requested — the limits of the model whose credential it holds
 *
 * RxJS pipeline uses groupBy(resourceId) + concatMap for per-resource isolation.
 *
 * ## Per-resource serialization
 *
 * `groupBy(resourceId) + concatMap(...)` is the stream-consumer flavor of
 * per-resource serialization — the same invariant enforced by `Smelter`,
 * `Weaver`, and (in a different shape) `ViewManager`. See
 * `packages/core/src/serialize-per-key.ts` for the shared primitive used
 * by RPC-style services.
 */

import { Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import type { EventMap, Logger, components, AnnotationId, ResourceId } from '@semiont/core';
import { EventBus, errField } from '@semiont/core';
import { withActorSpan } from '@semiont/observability';
import { answerLimitsRequests, type InferenceClient } from '@semiont/inference';
import type { EmbeddingProvider } from '@semiont/vectors';
import { AnnotationGather, type AnnotationGatherReads } from './annotation-gather';
import { LLMContext, type ResourceGatherReads } from './llm-context';

/**
 * The Gatherer's capability slice — DERIVED as the intersection of the two
 * gather paths' reads, never restated. A `KnowledgeBase` supplies all of it
 * but `content` and `anchoredText`: the in-process root wraps its working
 * tree (`workingTreeContentReads`) and asks for anchored text over the bus;
 * the standalone Librarian builds the slice from the shared stateDir (views),
 * network clients (graph/vectors/content), bus-fed progress folds, and the
 * same anchored-text bus read.
 */
export type GathererStores = AnnotationGatherReads & ResourceGatherReads;

export class Gatherer {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private stores: GathererStores,
    private eventBus: EventBus,
    private inferenceClient: InferenceClient,
    /** Settle bound for the resource-gather barrier — operator-owned config, threaded from `MakeMeaningConfig.gather`. */
    private settleTimeoutMs: number,
    logger: Logger,
    private embeddingProvider: EmbeddingProvider,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Gatherer actor initialized');

    const errorHandler = (err: unknown) => this.logger.error('Gatherer pipeline error', { error: err });

    // Annotation-level gather (for yield flow)
    const annotationGather$ = this.eventBus.frames('gather:requested').pipe(
      groupBy((frame) => frame.payload.resourceId),
      mergeMap((group$) =>
        group$.pipe(
          concatMap((frame) =>
            from(withActorSpan('gatherer', 'gather:requested', () => this.handleAnnotationGather(frame.payload, frame.correlationId))),
          ),
        ),
      ),
    );

    // Resource-level gather (for LLM context endpoint)
    const resourceGather$ = this.eventBus.frames('gather:resource-requested').pipe(
      groupBy((frame) => frame.payload.resourceId),
      mergeMap((group$) =>
        group$.pipe(
          concatMap((frame) =>
            from(withActorSpan('gatherer', 'gather:resource-requested', () => this.handleResourceGather(frame.payload, frame.correlationId))),
          ),
        ),
      ),
    );

    this.subscriptions.push(
      annotationGather$.subscribe({ error: errorHandler }),
      resourceGather$.subscribe({ error: errorHandler }),
      // It holds its model's credential, so it reports that model's limits.
      answerLimitsRequests(this.eventBus, 'gather:limits-requested', [this.inferenceClient], this.logger),
    );
  }

  // ========================================================================
  // Gather handlers
  // ========================================================================

  private async handleAnnotationGather(event: EventMap['gather:requested'], correlationId: string | undefined): Promise<void> {
    try {
      this.logger.debug('Gathering annotation context', {
        annotationId: event.annotationId,
        resourceId: event.resourceId,
      });

      const response = await AnnotationGather.buildLLMContext(
        event.annotationId,
        event.resourceId,
        this.stores,
        this.embeddingProvider,
        event.options ?? {},
        this.inferenceClient,
        this.logger,
      );

      this.eventBus.emit('gather:complete', { annotationId: event.annotationId,
        response, }, { correlationId });
    } catch (error) {
      this.logger.error('Gather annotation context failed', {
        annotationId: event.annotationId,
        error: errField(error),
      });
      this.eventBus.emit('gather:failed', { annotationId: event.annotationId,
        message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleResourceGather(event: EventMap['gather:resource-requested'], correlationId: string | undefined): Promise<void> {
    try {
      this.logger.debug('Gathering resource context', {
        resourceId: event.resourceId,
      });

      const result = await LLMContext.getResourceContext(
        event.resourceId,
        event.options,
        this.stores,
        this.inferenceClient,
        this.settleTimeoutMs,
        this.logger,
      );

      this.eventBus.emit('gather:resource-complete', { resourceId: event.resourceId,
        response: result, }, { correlationId });
    } catch (error) {
      this.logger.error('Gather resource context failed', {
        resourceId: event.resourceId,
        error: errField(error),
      });
      this.eventBus.emit('gather:resource-failed', { resourceId: event.resourceId,
        message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  async generateAnnotationSummary(
    annotationId: AnnotationId,
    resourceId: ResourceId,
  ): Promise<components['schemas']['ContextualSummaryResponse']> {
    return AnnotationGather.generateAnnotationSummary(
      annotationId,
      resourceId,
      this.stores,
      this.inferenceClient,
    );
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.logger.info('Gatherer actor stopped');
  }
}
