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
import type { EventStore } from '@semiont/event-sourcing';
import { burstBuffer } from '@semiont/core';
import type { Logger, StoredEvent, ResourceEvent } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import type { EventBus } from '@semiont/core';
import type { VectorStore, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/vectors';
import { chunkText, DEFAULT_CHUNKING_CONFIG } from '@semiont/vectors';
import type { WorkingTreeStore } from '@semiont/content';
import { getExactText, getTargetSelector } from '@semiont/api-client';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

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
        await this.handleResourceCreated(event);
        break;
      case 'resource.archived':
        await this.handleResourceArchived(event);
        break;
      case 'annotation.added':
        await this.handleAnnotationAdded(event);
        break;
      case 'annotation.removed':
        await this.handleAnnotationRemoved(event);
        break;
    }
  }

  private async handleResourceCreated(event: ResourceEvent): Promise<void> {
    const rid = makeResourceId(event.resourceId!);
    const storageUri = (event as any).storageUri;

    if (!storageUri) return;

    // Read content
    const content = await this.contentStore.retrieve(storageUri);
    if (!content) return;

    const text = new TextDecoder().decode(content);
    if (!text.trim()) return;

    // Chunk and embed
    const chunks = chunkText(text, this.chunkingConfig);
    const embeddingChunks: EmbeddingChunk[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.embeddingProvider.embed(chunks[i]);

      // Emit event for Stower to persist
      this.eventBus.get('embedding:computed').next({
        resourceId: rid,
        chunkIndex: i,
        chunkText: chunks[i],
        embedding,
        model: this.embeddingProvider.model(),
        dimensions: this.embeddingProvider.dimensions(),
      });

      embeddingChunks.push({ chunkIndex: i, text: chunks[i], embedding });
    }

    // Index into vector store
    if (embeddingChunks.length > 0) {
      await this.vectorStore.upsertResourceVectors(rid, embeddingChunks);
      this.logger.debug('Smelter indexed resource', {
        resourceId: String(rid),
        chunks: embeddingChunks.length,
      });
    }
  }

  private async handleResourceArchived(event: ResourceEvent): Promise<void> {
    const rid = makeResourceId(event.resourceId!);
    await this.vectorStore.deleteResourceVectors(rid);

    this.eventBus.get('embedding:deleted').next({ resourceId: rid });

    this.logger.debug('Smelter deleted resource vectors', {
      resourceId: String(rid),
    });
  }

  private async handleAnnotationAdded(event: ResourceEvent): Promise<void> {
    const annotation = (event as any).annotation as Annotation | undefined;
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
      entityTypes: (annotation as any).entityTypes ?? [],
      exactText,
    };

    await this.vectorStore.upsertAnnotationVector(aid, embedding, payload);

    this.logger.debug('Smelter indexed annotation', {
      annotationId: String(aid),
      resourceId: String(rid),
    });
  }

  private async handleAnnotationRemoved(event: ResourceEvent): Promise<void> {
    const annotationId = (event as any).annotationId as string | undefined;
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
