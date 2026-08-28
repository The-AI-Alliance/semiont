/**
 * Gatherer Actor
 *
 * LLM context assembly for the Knowledge System. Subscribes to gather events,
 * queries KB stores via context modules, and emits results back to the bus.
 *
 * From ARCHITECTURE.md:
 * "When a Generator Agent or Linker Agent emits a gather event, the Gatherer
 * receives it from the bus, queries the relevant KB stores, and assembles
 * the context needed for downstream work."
 *
 * Handles:
 * - gather:requested — annotation-level LLM context assembly
 * - gather:resource-requested — resource-level LLM context assembly
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
import { EventBus, annotationId as makeAnnotationId, resourceId, errField } from '@semiont/core';
import { withActorSpan } from '@semiont/observability';
import type { InferenceClient } from '@semiont/inference';
import type { EmbeddingProvider } from '@semiont/vectors';
import { AnnotationContext, type AnnotationGatherReads } from './annotation-context';
import { LLMContext, type ResourceGatherReads } from './llm-context';

/**
 * The Gatherer's capability slice (EXTRACT-LIBRARIAN P2) — DERIVED as the
 * intersection of the two gather paths' reads, never restated. A full
 * `KnowledgeBase` satisfies it structurally; the standalone Librarian (P3)
 * builds it from the shared stateDir (views), the network clients
 * (graph/vectors), bus-fed progress folds, and D-CONTENT's answer (content).
 */
export type GathererStores = AnnotationGatherReads & ResourceGatherReads;

/**
 * The request channels Gatherer subscribes to — the Librarian's inbound wire
 * roster for this actor (P3). Pinned to `initialize()`'s actual subscriptions
 * by the census gate in gatherer-decoupling.test.ts.
 */
export const GATHERER_CHANNELS = [
  'gather:requested',
  'gather:resource-requested',
] as const satisfies readonly (keyof EventMap)[];

export class Gatherer {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private stores: GathererStores,
    private eventBus: EventBus,
    private inferenceClient: InferenceClient,
    /** Settle bound for the resource-gather barrier — operator-owned config (D5), threaded from `MakeMeaningConfig.gather`. */
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
    const annotationGather$ = this.eventBus.get('gather:requested').pipe(
      groupBy((event) => event.resourceId),
      mergeMap((group$) =>
        group$.pipe(
          concatMap((event) =>
            from(withActorSpan('gatherer', 'gather:requested', () => this.handleAnnotationGather(event))),
          ),
        ),
      ),
    );

    // Resource-level gather (for LLM context endpoint)
    const resourceGather$ = this.eventBus.get('gather:resource-requested').pipe(
      groupBy((event) => event.resourceId),
      mergeMap((group$) =>
        group$.pipe(
          concatMap((event) =>
            from(withActorSpan('gatherer', 'gather:resource-requested', () => this.handleResourceGather(event))),
          ),
        ),
      ),
    );

    this.subscriptions.push(
      annotationGather$.subscribe({ error: errorHandler }),
      resourceGather$.subscribe({ error: errorHandler }),
    );
  }

  // ========================================================================
  // Gather handlers (existing)
  // ========================================================================

  private async handleAnnotationGather(event: EventMap['gather:requested']): Promise<void> {
    try {
      this.logger.debug('Gathering annotation context', {
        annotationId: event.annotationId,
        resourceId: event.resourceId,
      });

      const response = await AnnotationContext.buildLLMContext(
        makeAnnotationId(event.annotationId),
        resourceId(event.resourceId),
        this.stores,
        this.embeddingProvider,
        event.options ?? {},
        this.inferenceClient,
        this.logger,
      );

      this.eventBus.get('gather:complete').next({
        correlationId: event.correlationId,
        annotationId: event.annotationId,
        response,
      });
    } catch (error) {
      this.logger.error('Gather annotation context failed', {
        annotationId: event.annotationId,
        error: errField(error),
      });
      this.eventBus.get('gather:failed').next({
        correlationId: event.correlationId,
        annotationId: event.annotationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResourceGather(event: EventMap['gather:resource-requested']): Promise<void> {
    try {
      this.logger.debug('Gathering resource context', {
        resourceId: event.resourceId,
      });

      const result = await LLMContext.getResourceContext(
        resourceId(event.resourceId),
        event.options,
        this.stores,
        this.inferenceClient,
        this.settleTimeoutMs,
        this.logger,
      );

      this.eventBus.get('gather:resource-complete').next({
        correlationId: event.correlationId,
        resourceId: event.resourceId,
        response: result,
      });
    } catch (error) {
      this.logger.error('Gather resource context failed', {
        resourceId: event.resourceId,
        error: errField(error),
      });
      this.eventBus.get('gather:resource-failed').next({
        correlationId: event.correlationId,
        resourceId: event.resourceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async generateAnnotationSummary(
    annotationId: AnnotationId,
    resourceId: ResourceId,
  ): Promise<components['schemas']['ContextualSummaryResponse']> {
    return AnnotationContext.generateAnnotationSummary(
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
