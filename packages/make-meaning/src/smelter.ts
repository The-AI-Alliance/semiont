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
 * On startup, replays the event log. If embedding:computed events already exist
 * for a resource/annotation (matching model and dimensions), skips re-embedding
 * and just indexes into the VectorStore.
 *
 * Uses the same burst-buffer RxJS pipeline as GraphDBConsumer.
 */

import { Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { EventQuery, type EventStore } from '@semiont/event-sourcing';
import { burstBuffer } from '@semiont/core';
import type { ResourceId, AnnotationId, Logger, StoredEvent, ResourceEvent } from '@semiont/core';
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
    'embedding.computed',
  ]);

  private static readonly BURST_WINDOW_MS = 50;
  private static readonly MAX_BATCH_SIZE = 100;
  private static readonly IDLE_TIMEOUT_MS = 200;

  private _globalSubscription: any = null;
  private eventSubject = new Subject<StoredEvent>();
  private pipelineSubscription: Subscription | null = null;
  private readonly logger: Logger;
  private readonly chunkingConfig: ChunkingConfig;

  // Track which embeddings are already computed (model + resourceId/annotationId)
  private computedEmbeddings = new Set<string>();

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

    // Set up RxJS pipeline with burst buffering
    this.pipelineSubscription = this.eventSubject.pipe(
      groupBy((event) => {
        const resourceEvent = event.payload as ResourceEvent;
        return resourceEvent.resourceId ?? 'unknown';
      }),
      mergeMap((group$) =>
        group$.pipe(
          burstBuffer(Smelter.BURST_WINDOW_MS, Smelter.MAX_BATCH_SIZE, Smelter.IDLE_TIMEOUT_MS),
          concatMap((events: StoredEvent[]) => from(this.processBatch(events))),
        ),
      ),
    ).subscribe({
      error: (err) => this.logger.error('Smelter pipeline error', { error: err }),
    });

    // Replay existing events
    await this.replay();

    // Subscribe to new events
    this._globalSubscription = this.eventStore.subscribe((event: StoredEvent) => {
      if (Smelter.SMELTER_RELEVANT_EVENTS.has(event.type)) {
        this.eventSubject.next(event);
      }
    });

    this.logger.info('Smelter actor initialized');
  }

  async stop(): Promise<void> {
    if (this._globalSubscription) {
      this._globalSubscription.unsubscribe?.() ?? this._globalSubscription();
      this._globalSubscription = null;
    }
    this.pipelineSubscription?.unsubscribe();
    this.eventSubject.complete();
    this.logger.info('Smelter actor stopped');
  }

  private async replay(): Promise<void> {
    this.logger.info('Smelter replaying event log');

    const events = await this.eventStore.queryEvents(
      new EventQuery().types([...Smelter.SMELTER_RELEVANT_EVENTS])
    );

    for (const event of events) {
      if (event.type === 'embedding.computed') {
        // Record that this embedding exists — skip re-embedding during replay
        const payload = event.payload as any;
        const key = this.embeddingKey(payload.resourceId, payload.annotationId, payload.chunkIndex);
        this.computedEmbeddings.add(key);

        // Index into vector store
        await this.indexEmbedding(payload);
      } else {
        await this.processEvent(event);
      }
    }

    this.logger.info('Smelter replay complete', {
      existingEmbeddings: this.computedEmbeddings.size,
    });
  }

  private async processBatch(events: StoredEvent[]): Promise<void> {
    for (const event of events) {
      await this.processEvent(event);
    }
  }

  private async processEvent(event: StoredEvent): Promise<void> {
    try {
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
    } catch (err) {
      this.logger.error('Smelter failed to process event', {
        type: event.type,
        error: err,
      });
    }
  }

  private async handleResourceCreated(event: StoredEvent): Promise<void> {
    const payload = event.payload as ResourceEvent & { storageUri?: string };
    const rid = makeResourceId(payload.resourceId);

    if (!payload.storageUri) return;

    // Read content
    const content = await this.contentStore.retrieve(payload.storageUri);
    if (!content) return;

    const text = new TextDecoder().decode(content);
    if (!text.trim()) return;

    // Chunk
    const chunks = chunkText(text, this.chunkingConfig);

    // Embed and persist each chunk
    const embeddingChunks: EmbeddingChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const key = this.embeddingKey(String(rid), undefined, i);
      if (this.computedEmbeddings.has(key)) {
        continue; // Already embedded
      }

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

      this.computedEmbeddings.add(key);
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

  private async handleResourceArchived(event: StoredEvent): Promise<void> {
    const payload = event.payload as ResourceEvent;
    const rid = makeResourceId(payload.resourceId);

    await this.vectorStore.deleteResourceVectors(rid);

    this.eventBus.get('embedding:deleted').next({ resourceId: rid });

    this.logger.debug('Smelter deleted resource vectors', {
      resourceId: String(rid),
    });
  }

  private async handleAnnotationAdded(event: StoredEvent): Promise<void> {
    const payload = event.payload as ResourceEvent & { annotation?: Annotation };
    const annotation = payload.annotation;
    if (!annotation || !annotation.id) return;

    const rid = makeResourceId(payload.resourceId);
    const aid = makeAnnotationId(annotation.id);

    // Get the exact text from the annotation target
    const exactText = getExactText(annotation);
    if (!exactText || !exactText.trim()) return;

    const key = this.embeddingKey(String(rid), String(aid), 0);
    if (this.computedEmbeddings.has(key)) return;

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

    this.computedEmbeddings.add(key);

    // Index into vector store
    const annotationPayload: AnnotationPayload = {
      annotationId: aid,
      resourceId: rid,
      motivation: annotation.motivation ?? '',
      entityTypes: (annotation as any).entityTypes ?? [],
      exactText,
    };

    await this.vectorStore.upsertAnnotationVector(aid, embedding, annotationPayload);

    this.logger.debug('Smelter indexed annotation', {
      annotationId: String(aid),
      resourceId: String(rid),
    });
  }

  private async handleAnnotationRemoved(event: StoredEvent): Promise<void> {
    const payload = event.payload as ResourceEvent & { annotationId?: string };
    if (!payload.annotationId) return;

    const rid = makeResourceId(payload.resourceId);
    const aid = makeAnnotationId(payload.annotationId);

    await this.vectorStore.deleteAnnotationVector(aid);

    this.eventBus.get('embedding:deleted').next({
      resourceId: rid,
      annotationId: aid,
    });

    this.logger.debug('Smelter deleted annotation vector', {
      annotationId: String(aid),
    });
  }

  private async indexEmbedding(payload: any): Promise<void> {
    const rid = makeResourceId(payload.resourceId) as ResourceId;

    if (payload.annotationId) {
      const aid = makeAnnotationId(payload.annotationId) as AnnotationId;
      await this.vectorStore.upsertAnnotationVector(aid, payload.embedding, {
        annotationId: aid,
        resourceId: rid,
        motivation: '',
        entityTypes: [],
        exactText: payload.chunkText,
      });
    } else {
      await this.vectorStore.upsertResourceVectors(rid, [{
        chunkIndex: payload.chunkIndex,
        text: payload.chunkText,
        embedding: payload.embedding,
      }]);
    }
  }

  private embeddingKey(resourceId: string, annotationId: string | undefined, chunkIndex: number): string {
    return annotationId
      ? `${resourceId}:${annotationId}:${chunkIndex}`
      : `${resourceId}::${chunkIndex}`;
  }
}
