/**
 * Smelter Actor
 *
 * Takes raw content, refines it into embedding vectors, persists them as events,
 * and indexes them into the vector store. Peer to the Graph Consumer.
 *
 * Pipeline:
 *   1. Subscribe to resource and annotation events from the EventStore
 *   2. Chunk resource text into overlapping passages
 *   3. Embed each chunk via the configured EmbeddingProvider
 *   4. Emit embedding:computed events on the EventBus (persisted by Stower)
 *   5. Index vectors into the VectorStore (Qdrant) for fast similarity search
 *
 * Uses the same burst-buffer RxJS pipeline as GraphDBConsumer.
 */

import { Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { type EventStore, EventQuery } from '@semiont/event-sourcing';
import { burstBuffer } from '@semiont/core';
import type { Logger, StoredEvent, ResourceCreatedEvent, ResourceArchivedEvent, AnnotationAddedEvent, AnnotationRemovedEvent } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId, type EmbeddingComputedEvent, type EmbeddingDeletedEvent } from '@semiont/core';
import type { EventBus } from '@semiont/core';
import type { VectorStore, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/vectors';
import { chunkText, DEFAULT_CHUNKING_CONFIG } from '@semiont/vectors';
import type { WorkingTreeStore } from '@semiont/content';
import { getExactText, getTargetSelector } from '@semiont/api-client';

export class Smelter {
  private static readonly SMELTER_RELEVANT_EVENTS = new Set([
    'resource.created', 'resource.archived',
    'annotation.added', 'annotation.removed',
  ]);

  private static readonly BURST_WINDOW_MS = 50;
  private static readonly MAX_BATCH_SIZE = 100;
  private static readonly IDLE_TIMEOUT_MS = 200;

  private _globalSubscription: any = null;
  private eventSubject = new Subject<StoredEvent>();
  private pipelineSubscription: Subscription | null = null;
  private readonly logger: Logger;
  private readonly chunkingConfig: ChunkingConfig;

  constructor(
    private eventStore: EventStore,
    private eventBus: EventBus,
    private vectorStore: VectorStore,
    private embeddingProvider: EmbeddingProvider,
    private contentStore: WorkingTreeStore,
    logger: Logger,
    chunkingConfig?: ChunkingConfig,
  ) {
    this.logger = logger;
    this.chunkingConfig = chunkingConfig ?? DEFAULT_CHUNKING_CONFIG;
  }

  async initialize(): Promise<void> {
    this.logger.info('Smelter actor initializing');

    // Bridge: callback-based EventBus subscription → RxJS Subject
    this._globalSubscription = this.eventStore.bus.subscriptions.subscribeGlobal(
      (storedEvent: StoredEvent) => {
        if (!Smelter.SMELTER_RELEVANT_EVENTS.has(storedEvent.event.type)) return;
        this.eventSubject.next(storedEvent);
      }
    );

    // Build the RxJS pipeline
    this.pipelineSubscription = this.eventSubject.pipe(
      groupBy((se: StoredEvent) => se.event.resourceId ?? '__unknown__'),
      mergeMap((group) =>
        group.pipe(
          burstBuffer<StoredEvent>({
            burstWindowMs: Smelter.BURST_WINDOW_MS,
            maxBatchSize: Smelter.MAX_BATCH_SIZE,
            idleTimeoutMs: Smelter.IDLE_TIMEOUT_MS,
          }),
          concatMap((eventOrBatch: StoredEvent | StoredEvent[]) => {
            if (Array.isArray(eventOrBatch)) {
              return from(this.processBatch(eventOrBatch));
            }
            return from(this.safeProcessEvent(eventOrBatch));
          }),
        ),
      ),
    ).subscribe({
      error: (err) => this.logger.error('Smelter pipeline error', { error: err }),
    });

    this.logger.info('Smelter actor initialized');
  }

  async stop(): Promise<void> {
    if (this._globalSubscription && typeof this._globalSubscription.unsubscribe === 'function') {
      this._globalSubscription.unsubscribe();
    }
    this._globalSubscription = null;
    this.pipelineSubscription?.unsubscribe();
    this.eventSubject.complete();
    this.logger.info('Smelter actor stopped');
  }

  /**
   * Rebuild the vector store from persisted embedding events in the event log.
   * Reads all embedding.computed / embedding.deleted events and replays them.
   * Bypasses the live pipeline — reads directly from the event store.
   */
  async rebuildAll(): Promise<void> {
    this.logger.info('Rebuilding vector store from events');

    const allResourceIds = await this.eventStore.log.getAllResourceIds();
    this.logger.info('Found resources to scan', { count: allResourceIds.length });

    const query = new EventQuery(this.eventStore.log.storage);
    let indexed = 0;

    for (const rid of allResourceIds) {
      const events = await query.getResourceEvents(makeResourceId(rid as string));

      // Collect the final state: last embedding.deleted cancels prior embeddings
      const embeddingEvents = events.filter(
        (e) => e.event.type === 'embedding.computed' || e.event.type === 'embedding.deleted'
      );
      if (embeddingEvents.length === 0) continue;

      // Check if the resource was deleted (last event is embedding.deleted with no annotationId)
      const lastEvent = embeddingEvents[embeddingEvents.length - 1];
      if (lastEvent.event.type === 'embedding.deleted' && !(lastEvent.event as EmbeddingDeletedEvent).payload.annotationId) {
        continue; // Resource vectors were deleted, skip
      }

      // Replay computed events, skipping any whose annotation was later deleted
      const deletedAnnotations = new Set<string>();
      for (const e of embeddingEvents) {
        if (e.event.type === 'embedding.deleted') {
          const payload = (e.event as EmbeddingDeletedEvent).payload;
          if (payload.annotationId) deletedAnnotations.add(String(payload.annotationId));
        }
      }

      const resourceChunks: EmbeddingChunk[] = [];
      for (const e of embeddingEvents) {
        if (e.event.type !== 'embedding.computed') continue;
        const payload = (e.event as EmbeddingComputedEvent).payload;

        if (payload.annotationId) {
          if (deletedAnnotations.has(String(payload.annotationId))) continue;
          // Annotation vector
          await this.vectorStore.upsertAnnotationVector(
            makeAnnotationId(String(payload.annotationId)),
            payload.embedding,
            {
              annotationId: makeAnnotationId(String(payload.annotationId)),
              resourceId: makeResourceId(e.event.resourceId as string),
              motivation: '',
              entityTypes: [],
              exactText: payload.chunkText,
            },
          );
        } else {
          // Resource chunk
          resourceChunks.push({
            chunkIndex: payload.chunkIndex,
            text: payload.chunkText,
            embedding: payload.embedding,
          });
        }
      }

      if (resourceChunks.length > 0) {
        await this.vectorStore.upsertResourceVectors(
          makeResourceId(rid as string),
          resourceChunks,
        );
      }

      indexed++;
    }

    this.logger.info('Vector store rebuild complete', { resourcesIndexed: indexed });
  }

  private async processBatch(events: StoredEvent[]): Promise<void> {
    for (const event of events) {
      await this.safeProcessEvent(event);
    }
  }

  private async safeProcessEvent(storedEvent: StoredEvent): Promise<void> {
    try {
      await this.processEvent(storedEvent);
    } catch (err) {
      this.logger.error('Smelter failed to process event', {
        type: storedEvent.event.type,
        resourceId: storedEvent.event.resourceId,
        error: err,
      });
    }
  }

  private async processEvent(storedEvent: StoredEvent): Promise<void> {
    const event = storedEvent.event;

    switch (event.type) {
      case 'resource.created':
        await this.handleResourceCreated(event as ResourceCreatedEvent);
        break;
      case 'resource.archived':
        await this.handleResourceArchived(event as ResourceArchivedEvent);
        break;
      case 'annotation.added':
        await this.handleAnnotationAdded(event as AnnotationAddedEvent);
        break;
      case 'annotation.removed':
        await this.handleAnnotationRemoved(event as AnnotationRemovedEvent);
        break;
    }
  }

  private async handleResourceCreated(event: ResourceCreatedEvent): Promise<void> {
    const rid = makeResourceId(event.resourceId!);
    const storageUri = event.payload.storageUri;

    if (!storageUri) return;

    // Read content
    const content = await this.contentStore.retrieve(storageUri);
    if (!content) return;

    const text = new TextDecoder().decode(content);
    if (!text.trim()) return;

    // Chunk and embed in batch
    const chunks = chunkText(text, this.chunkingConfig);
    if (chunks.length === 0) return;

    const embeddings = await this.embeddingProvider.embedBatch(chunks);
    const model = this.embeddingProvider.model();
    const dimensions = this.embeddingProvider.dimensions();

    const embeddingChunks: EmbeddingChunk[] = chunks.map((text, i) => {
      this.eventBus.get('embedding:computed').next({
        resourceId: rid,
        chunkIndex: i,
        chunkText: text,
        embedding: embeddings[i],
        model,
        dimensions,
      });
      return { chunkIndex: i, text, embedding: embeddings[i] };
    });

    await this.vectorStore.upsertResourceVectors(rid, embeddingChunks);
    this.logger.debug('Smelter indexed resource', {
      resourceId: String(rid),
      chunks: embeddingChunks.length,
    });
  }

  private async handleResourceArchived(event: ResourceArchivedEvent): Promise<void> {
    const rid = makeResourceId(event.resourceId!);
    await this.vectorStore.deleteResourceVectors(rid);

    this.eventBus.get('embedding:deleted').next({ resourceId: rid });

    this.logger.debug('Smelter deleted resource vectors', {
      resourceId: String(rid),
    });
  }

  private async handleAnnotationAdded(event: AnnotationAddedEvent): Promise<void> {
    const annotation = event.payload.annotation;
    if (!annotation || !annotation.id) return;

    const rid = makeResourceId(event.resourceId!);
    const aid = makeAnnotationId(annotation.id);

    const selector = getTargetSelector(annotation.target);
    const exactText = getExactText(selector);
    if (!exactText || !exactText.trim()) return;

    const embedding = await this.embeddingProvider.embed(exactText);

    // Emit event for Stower to persist
    this.eventBus.get('embedding:computed').next({
      resourceId: rid,
      annotationId: aid,
      chunkIndex: 0,
      chunkText: exactText,
      embedding,
      model: this.embeddingProvider.model(),
      dimensions: this.embeddingProvider.dimensions(),
    });

    // Index into vector store
    const payload: AnnotationPayload = {
      annotationId: aid,
      resourceId: rid,
      motivation: annotation.motivation ?? '',
      entityTypes: ((annotation as Record<string, unknown>).entityTypes as string[] | undefined) ?? [],
      exactText,
    };

    await this.vectorStore.upsertAnnotationVector(aid, embedding, payload);

    this.logger.debug('Smelter indexed annotation', {
      annotationId: String(aid),
      resourceId: String(rid),
    });
  }

  private async handleAnnotationRemoved(event: AnnotationRemovedEvent): Promise<void> {
    const annotationId = String(event.payload.annotationId);
    if (!annotationId) return;

    const rid = makeResourceId(event.resourceId!);
    const aid = makeAnnotationId(annotationId);

    await this.vectorStore.deleteAnnotationVector(aid);

    this.eventBus.get('embedding:deleted').next({
      resourceId: rid,
      annotationId: aid,
    });

    this.logger.debug('Smelter deleted annotation vector', {
      annotationId: String(aid),
    });
  }
}
