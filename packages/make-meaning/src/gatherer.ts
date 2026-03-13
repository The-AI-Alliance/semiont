/**
 * Gatherer Actor
 *
 * The read actor for the knowledge base. Subscribes to gather and browse events,
 * queries KB stores via context modules, and emits results back to the bus.
 *
 * From ARCHITECTURE.md:
 * "When a Generator Agent or Linker Agent emits a gather event, the Gatherer
 * receives it from the bus, queries the relevant KB stores, and assembles
 * the context needed for downstream work."
 *
 * Handles:
 * - gather:requested / gather:resource-requested — LLM context assembly
 * - browse:resource-requested — single resource metadata (materialized from events)
 * - browse:resources-requested — list resources
 * - browse:annotations-requested — all annotations for a resource
 * - browse:annotation-requested — single annotation with resolved resource
 * - browse:events-requested — resource event history
 * - browse:annotation-history-requested — annotation event history
 * - mark:entity-types-requested — list entity types
 *
 * RxJS pipeline follows the GraphDBConsumer pattern:
 * - groupBy(resourceUri) for per-resource isolation (gather events)
 * - mergeMap for independent request-response (browse events)
 */

import { Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import type { EventMap, Logger, components } from '@semiont/core';
import { EventBus, annotationId as makeAnnotationId, uriToResourceId } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import { EventQuery } from '@semiont/event-sourcing';
import { getResourceEntityTypes, getBodySource } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import type { KnowledgeBase } from './knowledge-base';
import { AnnotationContext } from './annotation-context';
import { ResourceContext } from './resource-context';
import { LLMContext } from './llm-context';
import { readEntityTypesProjection } from './views/entity-types-reader';
import type { MakeMeaningConfig } from './config';

type Annotation = components['schemas']['Annotation'];
type StoredEvent = { event: any; metadata: any };

export class Gatherer {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    private inferenceClient: InferenceClient,
    logger: Logger,
    private config?: MakeMeaningConfig,
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

    // Browse reads — independent request-response, no grouping needed
    const browseResource$ = this.eventBus.get('browse:resource-requested').pipe(
      mergeMap((event) => from(this.handleBrowseResource(event))),
    );

    const browseResources$ = this.eventBus.get('browse:resources-requested').pipe(
      mergeMap((event) => from(this.handleBrowseResources(event))),
    );

    const browseAnnotations$ = this.eventBus.get('browse:annotations-requested').pipe(
      mergeMap((event) => from(this.handleBrowseAnnotations(event))),
    );

    const browseAnnotation$ = this.eventBus.get('browse:annotation-requested').pipe(
      mergeMap((event) => from(this.handleBrowseAnnotation(event))),
    );

    const browseEvents$ = this.eventBus.get('browse:events-requested').pipe(
      mergeMap((event) => from(this.handleBrowseEvents(event))),
    );

    const browseAnnotationHistory$ = this.eventBus.get('browse:annotation-history-requested').pipe(
      mergeMap((event) => from(this.handleBrowseAnnotationHistory(event))),
    );

    const markEntityTypes$ = this.eventBus.get('mark:entity-types-requested').pipe(
      mergeMap((event) => from(this.handleEntityTypes(event))),
    );

    this.subscriptions.push(
      annotationGather$.subscribe({ error: errorHandler }),
      resourceGather$.subscribe({ error: errorHandler }),
      browseResource$.subscribe({ error: errorHandler }),
      browseResources$.subscribe({ error: errorHandler }),
      browseAnnotations$.subscribe({ error: errorHandler }),
      browseAnnotation$.subscribe({ error: errorHandler }),
      browseEvents$.subscribe({ error: errorHandler }),
      browseAnnotationHistory$.subscribe({ error: errorHandler }),
      markEntityTypes$.subscribe({ error: errorHandler }),
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
      );

      this.eventBus.get('gather:complete').next({
        annotationId: event.annotationId,
        response,
      });
    } catch (error) {
      this.logger.error('Gather annotation context failed', {
        annotationId: event.annotationId,
        error,
      });
      this.eventBus.get('gather:failed').next({
        annotationId: event.annotationId,
        error: error instanceof Error ? error : new Error(String(error)),
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
        resourceId: event.resourceId,
        context: result,
      });
    } catch (error) {
      this.logger.error('Gather resource context failed', {
        resourceId: event.resourceId,
        error,
      });
      this.eventBus.get('gather:resource-failed').next({
        resourceId: event.resourceId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // ========================================================================
  // Browse handlers (new — knowledge base reads)
  // ========================================================================

  private async handleBrowseResource(event: EventMap['browse:resource-requested']): Promise<void> {
    try {
      // Materialize from event store (matches get-uri.ts JSON-LD path)
      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const events = await eventQuery.getResourceEvents(event.resourceId);
      const stored = await this.kb.eventStore.views.materializer.materialize(events, event.resourceId);

      if (!stored) {
        this.eventBus.get('browse:resource-failed').next({
          correlationId: event.correlationId,
          error: new Error('Resource not found'),
        });
        return;
      }

      const annotations = stored.annotations.annotations;
      const entityReferences = annotations.filter((a: Annotation) => {
        if (a.motivation !== 'linking') return false;
        return getEntityTypes({ body: a.body }).length > 0;
      });

      this.eventBus.get('browse:resource-result').next({
        correlationId: event.correlationId,
        response: {
          resource: stored.resource,
          annotations,
          entityReferences,
        },
      });
    } catch (error) {
      this.logger.error('Browse resource failed', { resourceId: event.resourceId, error });
      this.eventBus.get('browse:resource-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleBrowseResources(event: EventMap['browse:resources-requested']): Promise<void> {
    try {
      let filteredDocs = await ResourceContext.listResources({
        search: event.search,
        archived: event.archived,
      }, this.kb);

      // Filter by entity type
      if (event.entityType) {
        filteredDocs = filteredDocs.filter((doc) => getResourceEntityTypes(doc).includes(event.entityType!));
      }

      // Paginate
      const offset = event.offset ?? 0;
      const limit = event.limit ?? 50;
      const paginatedDocs = filteredDocs.slice(offset, offset + limit);

      // Add content previews for search results
      const formattedDocs = event.search
        ? await ResourceContext.addContentPreviews(paginatedDocs, this.kb)
        : paginatedDocs;

      this.eventBus.get('browse:resources-result').next({
        correlationId: event.correlationId,
        response: {
          resources: formattedDocs,
          total: filteredDocs.length,
          offset,
          limit,
        },
      });
    } catch (error) {
      this.logger.error('Browse resources failed', { error });
      this.eventBus.get('browse:resources-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleBrowseAnnotations(event: EventMap['browse:annotations-requested']): Promise<void> {
    try {
      const annotations = await AnnotationContext.getAllAnnotations(event.resourceId, this.kb);

      this.eventBus.get('browse:annotations-result').next({
        correlationId: event.correlationId,
        response: {
          annotations,
          total: annotations.length,
        },
      });
    } catch (error) {
      this.logger.error('Browse annotations failed', { resourceId: event.resourceId, error });
      this.eventBus.get('browse:annotations-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleBrowseAnnotation(event: EventMap['browse:annotation-requested']): Promise<void> {
    try {
      const annotation = await AnnotationContext.getAnnotation(event.annotationId, event.resourceId, this.kb);

      if (!annotation) {
        this.eventBus.get('browse:annotation-failed').next({
          correlationId: event.correlationId,
          error: new Error('Annotation not found'),
        });
        return;
      }

      const resource = await ResourceContext.getResourceMetadata(event.resourceId, this.kb);

      // Resolve linked resource if annotation body contains a link
      let resolvedResource = null;
      const bodySource = getBodySource(annotation.body);
      if (bodySource) {
        resolvedResource = await ResourceContext.getResourceMetadata(uriToResourceId(bodySource), this.kb);
      }

      this.eventBus.get('browse:annotation-result').next({
        correlationId: event.correlationId,
        response: {
          annotation,
          resource,
          resolvedResource,
        },
      });
    } catch (error) {
      this.logger.error('Browse annotation failed', { resourceId: event.resourceId, annotationId: event.annotationId, error });
      this.eventBus.get('browse:annotation-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleBrowseEvents(event: EventMap['browse:events-requested']): Promise<void> {
    try {
      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const filters: any = {
        resourceId: event.resourceId,
      };

      if (event.type) {
        filters.eventTypes = [event.type];
      }
      if (event.userId) {
        filters.userId = event.userId;
      }
      if (event.limit) {
        filters.limit = event.limit;
      }

      const storedEvents = await eventQuery.queryEvents(filters);

      const events = storedEvents.map((stored: StoredEvent) => ({
        event: {
          id: stored.event.id,
          type: stored.event.type,
          timestamp: stored.event.timestamp,
          userId: stored.event.userId,
          resourceId: stored.event.resourceId,
          payload: stored.event.payload,
        },
        metadata: {
          sequenceNumber: stored.metadata.sequenceNumber,
          prevEventHash: stored.metadata.prevEventHash,
          checksum: stored.metadata.checksum,
        },
      }));

      this.eventBus.get('browse:events-result').next({
        correlationId: event.correlationId,
        response: {
          events,
          total: events.length,
          resourceId: event.resourceId,
        },
      });
    } catch (error) {
      this.logger.error('Browse events failed', { resourceId: event.resourceId, error });
      this.eventBus.get('browse:events-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleBrowseAnnotationHistory(event: EventMap['browse:annotation-history-requested']): Promise<void> {
    try {
      // Verify annotation exists
      const annotation = await AnnotationContext.getAnnotation(event.annotationId, event.resourceId, this.kb);
      if (!annotation) {
        this.eventBus.get('browse:annotation-history-failed').next({
          correlationId: event.correlationId,
          error: new Error('Annotation not found'),
        });
        return;
      }

      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const allEvents = await eventQuery.queryEvents({ resourceId: event.resourceId });

      // Filter events related to this annotation
      const annotationEvents = allEvents.filter((stored: StoredEvent) => {
        const ev = stored.event;
        if ('highlightId' in ev.payload && ev.payload.highlightId === event.annotationId) return true;
        if ('referenceId' in ev.payload && ev.payload.referenceId === event.annotationId) return true;
        return false;
      });

      const events = annotationEvents.map((stored: StoredEvent) => ({
        id: stored.event.id,
        type: stored.event.type,
        timestamp: stored.event.timestamp,
        userId: stored.event.userId,
        resourceId: stored.event.resourceId,
        payload: stored.event.payload,
        metadata: {
          sequenceNumber: stored.metadata.sequenceNumber,
          prevEventHash: stored.metadata.prevEventHash,
          checksum: stored.metadata.checksum,
        },
      }));

      // Sort by sequence number
      events.sort((a: any, b: any) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

      this.eventBus.get('browse:annotation-history-result').next({
        correlationId: event.correlationId,
        response: {
          events,
          total: events.length,
          annotationId: event.annotationId,
          resourceId: event.resourceId,
        },
      });
    } catch (error) {
      this.logger.error('Browse annotation history failed', { resourceId: event.resourceId, annotationId: event.annotationId, error });
      this.eventBus.get('browse:annotation-history-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // ========================================================================
  // Mark handlers (entity type reads)
  // ========================================================================

  private async handleEntityTypes(event: EventMap['mark:entity-types-requested']): Promise<void> {
    try {
      if (!this.config) {
        throw new Error('MakeMeaningConfig required for entity type reads');
      }
      const entityTypes = await readEntityTypesProjection(this.config);

      this.eventBus.get('mark:entity-types-result').next({
        correlationId: event.correlationId,
        response: { entityTypes },
      });
    } catch (error) {
      this.logger.error('Entity types read failed', { error });
      this.eventBus.get('mark:entity-types-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.logger.info('Gatherer actor stopped');
  }
}
