/**
 * Gatherer Actor
 *
 * Bridge between the event bus and the knowledge base for context assembly.
 * Subscribes to gather events, queries KB stores via context modules,
 * and emits results back to the bus.
 *
 * From ARCHITECTURE-NEXT.md:
 * "When a Generator Agent or Linker Agent emits a gather event, the Gatherer
 * receives it from the bus, queries the relevant KB stores, and assembles
 * the context needed for downstream work."
 *
 * RxJS pipeline follows the GraphDBConsumer pattern:
 * - groupBy(resourceUri) for per-resource isolation
 * - mergeMap over groups for cross-resource parallelism
 * - concatMap within each group for per-resource ordering
 */

import { Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import type { EventMap, Logger } from '@semiont/core';
import { EventBus, annotationUri as makeAnnotationUri, uriToResourceId } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { KnowledgeBase } from './knowledge-base';
import { AnnotationContext } from './annotation-context';
import { LLMContext } from './llm-context';

export class Gatherer {
  private annotationSubscription: Subscription | null = null;
  private resourceSubscription: Subscription | null = null;
  private readonly logger: Logger;

  constructor(
    private publicURL: string,
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    private inferenceClient: InferenceClient,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Gatherer actor initialized');

    // Annotation-level gather (for yield flow)
    const annotationGather$ = this.eventBus.get('gather:requested').pipe(
      groupBy((event) => event.resourceUri),
      mergeMap((group$) =>
        group$.pipe(
          concatMap((event) => from(this.handleAnnotationGather(event))),
        ),
      ),
    );

    // Resource-level gather (for LLM context endpoint)
    const resourceGather$ = this.eventBus.get('gather:resource-requested').pipe(
      groupBy((event) => event.resourceUri),
      mergeMap((group$) =>
        group$.pipe(
          concatMap((event) => from(this.handleResourceGather(event))),
        ),
      ),
    );

    const errorHandler = (err: unknown) => this.logger.error('Gatherer pipeline error', { error: err });

    this.annotationSubscription = annotationGather$.subscribe({ error: errorHandler });
    this.resourceSubscription = resourceGather$.subscribe({ error: errorHandler });
  }

  private async handleAnnotationGather(event: EventMap['gather:requested']): Promise<void> {
    try {
      this.logger.debug('Gathering annotation context', {
        annotationUri: event.annotationUri,
        resourceUri: event.resourceUri,
      });

      const result = await AnnotationContext.buildLLMContext(
        makeAnnotationUri(event.annotationUri),
        uriToResourceId(event.resourceUri),
        this.kb,
        {},
        this.inferenceClient,
        this.logger,
      );

      this.eventBus.get('gather:complete').next({
        annotationUri: event.annotationUri,
        context: result.context!,
      });
    } catch (error) {
      this.logger.error('Gather annotation context failed', {
        annotationUri: event.annotationUri,
        error,
      });
      this.eventBus.get('gather:failed').next({
        annotationUri: event.annotationUri,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleResourceGather(event: EventMap['gather:resource-requested']): Promise<void> {
    try {
      this.logger.debug('Gathering resource context', {
        resourceUri: event.resourceUri,
      });

      const publicURL = this.publicURL;
      const result = await LLMContext.getResourceContext(
        uriToResourceId(event.resourceUri),
        event.options,
        this.kb,
        publicURL,
        this.inferenceClient,
      );

      this.eventBus.get('gather:resource-complete').next({
        resourceUri: event.resourceUri,
        context: result,
      });
    } catch (error) {
      this.logger.error('Gather resource context failed', {
        resourceUri: event.resourceUri,
        error,
      });
      this.eventBus.get('gather:resource-failed').next({
        resourceUri: event.resourceUri,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async stop(): Promise<void> {
    this.annotationSubscription?.unsubscribe();
    this.annotationSubscription = null;
    this.resourceSubscription?.unsubscribe();
    this.resourceSubscription = null;
    this.logger.info('Gatherer actor stopped');
  }
}
