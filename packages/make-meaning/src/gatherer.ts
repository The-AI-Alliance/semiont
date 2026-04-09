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
 */

import { Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import type { EventMap, Logger, components, AnnotationId, ResourceId } from '@semiont/core';
import { EventBus, annotationId as makeAnnotationId } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { KnowledgeBase } from './knowledge-base';
import { AnnotationContext } from './annotation-context';
import { LLMContext } from './llm-context';

export class Gatherer {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    private inferenceClient: InferenceClient,
    logger: Logger,
    private embeddingProvider?: EmbeddingProvider,
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
          concatMap((event) => from(this.handleAnnotationGather(event))),
        ),
      ),
    );

    // Resource-level gather (for LLM context endpoint)
    const resourceGather$ = this.eventBus.get('gather:resource-requested').pipe(
      groupBy((event) => event.resourceId),
      mergeMap((group$) =>
        group$.pipe(
          concatMap((event) => from(this.handleResourceGather(event))),
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
        event.resourceId,
        this.kb,
        event.options ?? {},
        this.inferenceClient,
        this.logger,
        this.embeddingProvider,
      );

      this.eventBus.get('gather:complete').next({
        correlationId: event.correlationId,
        annotationId: event.annotationId,
        response,
      });
    } catch (error) {
      this.logger.error('Gather annotation context failed', {
        annotationId: event.annotationId,
        error,
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
        event.resourceId,
        event.options,
        this.kb,
        this.inferenceClient,
      );

      this.eventBus.get('gather:resource-complete').next({
        correlationId: event.correlationId,
        resourceId: event.resourceId,
        response: result,
      });
    } catch (error) {
      this.logger.error('Gather resource context failed', {
        resourceId: event.resourceId,
        error,
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
      this.kb,
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
