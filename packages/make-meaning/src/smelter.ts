/**
 * Smelter Actor
 *
 * Takes raw content, refines it into embedding vectors, persists them to the
 * EmbeddingStore (.semiont/embeddings/), and indexes them into the VectorStore
 * (Qdrant). Peer to the Graph Consumer.
 *
 * Pipeline:
 *   1. Subscribe to resource and annotation events from the EventStore
 *   2. Chunk resource text into overlapping passages
 *   3. Embed each chunk via the configured EmbeddingProvider
 *   4. Write vectors to EmbeddingStore (overwrite-in-place, git-durable)
 *   5. Index vectors into the VectorStore (Qdrant) for fast similarity search
 *
 * Uses the same burst-buffer RxJS pipeline as GraphDBConsumer.
 */

import { Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { type EventStore, type ViewStorage } from '@semiont/event-sourcing';
import { burstBuffer } from '@semiont/core';
import type { Logger, StoredEvent, PersistedEvent, EventOfType } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import type { EventBus } from '@semiont/core';
import type { VectorStore, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/vectors';
import { chunkText, DEFAULT_CHUNKING_CONFIG } from '@semiont/vectors';
import type { WorkingTreeStore } from '@semiont/content';
import { getExactText, getTargetSelector } from '@semiont/api-client';
import type { EmbeddingStore } from './embedding-store.js';
import { partitionByType } from './batch-utils.js';

export class Smelter {
  private static readonly SMELTER_RELEVANT_EVENTS: Set<PersistedEvent['type']> = new Set([
    'yield:created', 'yield:updated', 'yield:representation-added',
    'mark:archived', 'mark:added', 'mark:removed',
  ]);

  private static readonly BURST_WINDOW_MS = 50;
  private static readonly MAX_BATCH_SIZE = 100;
  private static readonly IDLE_TIMEOUT_MS = 200;

  private _globalSubscriptions: Subscription[] = [];
  private eventSubject = new Subject<StoredEvent>();
  private pipelineSubscription: Subscription | null = null;
  private readonly logger: Logger;
  private readonly chunkingConfig: ChunkingConfig;

  constructor(
    _eventStore: EventStore,
    private eventBus: EventBus,
    private vectorStore: VectorStore,
    private embeddingProvider: EmbeddingProvider,
    private contentStore: WorkingTreeStore,
    private embeddingStore: EmbeddingStore,
    private viewStorage: ViewStorage,
    logger: Logger,
    chunkingConfig?: ChunkingConfig,
  ) {
    this.logger = logger;
    this.chunkingConfig = chunkingConfig ?? DEFAULT_CHUNKING_CONFIG;
  }

  async initialize(): Promise<void> {
    this.logger.info('Smelter actor initializing');

    for (const eventType of Smelter.SMELTER_RELEVANT_EVENTS) {
      this._globalSubscriptions.push(
        this.eventBus.getDomainEvent(eventType).subscribe(
          (storedEvent: StoredEvent) => this.eventSubject.next(storedEvent)
        )
      );
    }

    this.pipelineSubscription = this.eventSubject.pipe(
      groupBy((se: StoredEvent) => se.resourceId ?? '__unknown__'),
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
    for (const sub of this._globalSubscriptions) sub.unsubscribe();
    this._globalSubscriptions = [];
    this.pipelineSubscription?.unsubscribe();
    this.eventSubject.complete();
    this.logger.info('Smelter actor stopped');
  }

  /**
   * Rebuild the vector store from the EmbeddingStore (.semiont/embeddings/).
   *
   * For each stored file, checks whether the model matches the configured
   * provider. On mismatch, re-embeds from the stored text and overwrites the
   * file before upserting into Qdrant. On match, loads the stored vectors
   * directly — no embedding provider calls needed.
   */
  async rebuildAll(): Promise<void> {
    this.logger.info('Rebuilding vector store from EmbeddingStore');

    await this.vectorStore.clearAll();

    const currentModel = this.embeddingProvider.model();
    const currentDimensions = this.embeddingProvider.dimensions();

    // ── Resources ─────────────────────────────────────────────────────────────
    const resourceIds = await this.embeddingStore.getAllResourceIds();
    this.logger.info('Found resource embedding files', { count: resourceIds.length });

    let resourcesIndexed = 0;

    for (const rid of resourceIds) {
      const resourceId = makeResourceId(rid);
      const stored = await this.embeddingStore.readResourceEmbeddings(resourceId);
      if (!stored || stored.chunks.length === 0) continue;

      let chunks: EmbeddingChunk[];

      if (stored.model !== currentModel) {
        // Model mismatch — re-embed from stored text
        this.logger.info('Re-embedding resource (model mismatch)', {
          resourceId: rid, storedModel: stored.model, currentModel,
        });
        const texts = stored.chunks.map(c => c.text);
        const embeddings = await this.embeddingProvider.embedBatch(texts);
        chunks = stored.chunks.map((c, i) => ({
          chunkIndex: c.chunkIndex,
          text: c.text,
          embedding: embeddings[i],
        }));
        await this.embeddingStore.writeResourceChunks(resourceId, currentModel, currentDimensions, chunks);
      } else {
        chunks = stored.chunks;
      }

      await this.vectorStore.upsertResourceVectors(resourceId, chunks);
      resourcesIndexed++;
    }

    // ── Annotations ───────────────────────────────────────────────────────────
    const annotationIds = await this.embeddingStore.getAllAnnotationIds();
    this.logger.info('Found annotation embedding files', { count: annotationIds.length });

    let annotationsIndexed = 0;

    for (const aid of annotationIds) {
      const annotationId = makeAnnotationId(aid);
      const stored = await this.embeddingStore.readAnnotationEmbedding(annotationId);
      if (!stored) continue;

      let embedding: number[];

      if (stored.model !== currentModel) {
        this.logger.info('Re-embedding annotation (model mismatch)', {
          annotationId: aid, storedModel: stored.model, currentModel,
        });
        embedding = await this.embeddingProvider.embed(stored.text);
        await this.embeddingStore.writeAnnotationEmbedding(
          annotationId,
          makeResourceId(stored.resourceId),
          currentModel,
          currentDimensions,
          stored.text,
          embedding,
          stored.motivation,
          stored.entityTypes,
        );
      } else {
        embedding = stored.embedding;
      }

      const payload: AnnotationPayload = {
        annotationId,
        resourceId: makeResourceId(stored.resourceId),
        motivation: stored.motivation,
        entityTypes: stored.entityTypes,
        exactText: stored.text,
      };
      await this.vectorStore.upsertAnnotationVector(annotationId, embedding, payload);
      annotationsIndexed++;
    }

    // ── Back-fill: resources in materialized views with no embedding file ─────
    // Catches resources where the file was never written (crash mid-embed,
    // pre-migration KB, etc.). Uses the already-rebuilt view store rather than
    // scanning the event log — cheaper and provides storageUri directly.
    const storedResourceIdSet = new Set(resourceIds);
    const allViews = await this.viewStorage.getAll();
    let backfilled = 0;

    for (const view of allViews) {
      const ridStr = view.resource['@id'];
      if (storedResourceIdSet.has(ridStr)) continue;
      if (view.resource.archived) continue;
      if (!view.resource.storageUri) continue;

      const content = await this.contentStore.retrieve(view.resource.storageUri);
      if (!content) continue;

      const text = new TextDecoder().decode(content);
      if (!text.trim()) continue;

      const chunks = chunkText(text, this.chunkingConfig);
      if (chunks.length === 0) continue;

      const rid = makeResourceId(ridStr);
      const embeddings = await this.embeddingProvider.embedBatch(chunks);
      const embeddingChunks: EmbeddingChunk[] = chunks.map((chunkText, i) => ({
        chunkIndex: i, text: chunkText, embedding: embeddings[i],
      }));

      await this.embeddingStore.writeResourceChunks(rid, currentModel, currentDimensions, embeddingChunks);
      await this.vectorStore.upsertResourceVectors(rid, embeddingChunks);
      backfilled++;
      resourcesIndexed++;

      this.logger.info('Smelter back-filled missing resource embedding', { resourceId: ridStr });
    }

    this.logger.info('Vector store rebuild complete', { resourcesIndexed, annotationsIndexed, backfilled });
  }

  private async processBatch(events: StoredEvent[]): Promise<void> {
    const runs = partitionByType(events);

    for (const run of runs) {
      try {
        if (run.length === 1) {
          await this.safeProcessEvent(run[0]);
        } else {
          await this.applyBatchByType(run);
        }
      } catch (error) {
        this.logger.error('Smelter failed to process batch run', {
          eventType: run[0].type,
          runSize: run.length,
          error,
        });
      }
    }
  }

  /**
   * Batch-optimized processing for consecutive events of the same type.
   */
  private async applyBatchByType(events: StoredEvent[]): Promise<void> {
    const type = events[0].type;

    switch (type) {
      case 'yield:created':
        await this.batchResourceCreated(events);
        break;
      case 'mark:added':
        await this.batchAnnotationAdded(events);
        break;
      default:
        for (const event of events) {
          await this.safeProcessEvent(event);
        }
    }
  }

  /**
   * Batch-embed chunks from multiple yield:created events in a single
   * embedBatch() call, then write to EmbeddingStore and index per resource.
   */
  private async batchResourceCreated(events: StoredEvent[]): Promise<void> {
    const resourceData: { rid: ReturnType<typeof makeResourceId>; chunks: string[] }[] = [];
    const allChunks: string[] = [];

    for (const storedEvent of events) {
      const event = storedEvent as EventOfType<'yield:created'>;
      const rid = makeResourceId(event.resourceId!);
      const storageUri = event.payload.storageUri;
      if (!storageUri) continue;

      const content = await this.contentStore.retrieve(storageUri);
      if (!content) continue;

      const text = new TextDecoder().decode(content);
      if (!text.trim()) continue;

      const chunks = chunkText(text, this.chunkingConfig);
      if (chunks.length === 0) continue;

      resourceData.push({ rid, chunks });
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) return;

    const allEmbeddings = await this.embeddingProvider.embedBatch(allChunks);
    const model = this.embeddingProvider.model();
    const dimensions = this.embeddingProvider.dimensions();

    let offset = 0;
    for (const { rid, chunks } of resourceData) {
      const embeddingChunks: EmbeddingChunk[] = chunks.map((text, i) => ({
        chunkIndex: i, text, embedding: allEmbeddings[offset + i],
      }));

      await this.embeddingStore.writeResourceChunks(rid, model, dimensions, embeddingChunks);
      await this.vectorStore.upsertResourceVectors(rid, embeddingChunks);
      this.logger.debug('Smelter batch-indexed resource', {
        resourceId: String(rid), chunks: embeddingChunks.length,
      });

      offset += chunks.length;
    }
  }

  /**
   * Batch-embed exact texts from multiple mark:added events in a single
   * embedBatch() call, then write to EmbeddingStore and index per annotation.
   */
  private async batchAnnotationAdded(events: StoredEvent[]): Promise<void> {
    const annotationData: {
      rid: ReturnType<typeof makeResourceId>;
      aid: ReturnType<typeof makeAnnotationId>;
      exactText: string;
      motivation: string;
      entityTypes: string[];
    }[] = [];

    for (const storedEvent of events) {
      const event = storedEvent as EventOfType<'mark:added'>;
      const annotation = event.payload.annotation;
      if (!annotation?.id) continue;

      const selector = getTargetSelector(annotation.target);
      const exactText = getExactText(selector);
      if (!exactText?.trim()) continue;

      annotationData.push({
        rid: makeResourceId(event.resourceId!),
        aid: makeAnnotationId(annotation.id),
        exactText,
        motivation: annotation.motivation ?? '',
        entityTypes: ((annotation as Record<string, unknown>).entityTypes as string[] | undefined) ?? [],
      });
    }

    if (annotationData.length === 0) return;

    const allEmbeddings = await this.embeddingProvider.embedBatch(
      annotationData.map(a => a.exactText),
    );
    const model = this.embeddingProvider.model();
    const dimensions = this.embeddingProvider.dimensions();

    for (let i = 0; i < annotationData.length; i++) {
      const { rid, aid, exactText, motivation, entityTypes } = annotationData[i];
      const embedding = allEmbeddings[i];

      await this.embeddingStore.writeAnnotationEmbedding(
        aid, rid, model, dimensions, exactText, embedding, motivation, entityTypes,
      );

      const payload: AnnotationPayload = {
        annotationId: aid, resourceId: rid, motivation, entityTypes, exactText,
      };
      await this.vectorStore.upsertAnnotationVector(aid, embedding, payload);
      this.logger.debug('Smelter batch-indexed annotation', {
        annotationId: String(aid), resourceId: String(rid),
      });
    }
  }

  private async safeProcessEvent(storedEvent: StoredEvent): Promise<void> {
    try {
      await this.processEvent(storedEvent);
    } catch (err) {
      this.logger.error('Smelter failed to process event', {
        type: storedEvent.type,
        resourceId: storedEvent.resourceId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  private async processEvent(storedEvent: StoredEvent): Promise<void> {
    switch (storedEvent.type) {
      case 'yield:created':
        await this.handleResourceCreated(storedEvent as EventOfType<'yield:created'>);
        break;
      case 'yield:updated':
        await this.handleResourceUpdated(storedEvent as EventOfType<'yield:updated'>);
        break;
      case 'yield:representation-added':
        await this.handleRepresentationAdded(storedEvent as EventOfType<'yield:representation-added'>);
        break;
      case 'mark:archived':
        await this.handleResourceArchived(storedEvent as EventOfType<'mark:archived'>);
        break;
      case 'mark:added':
        await this.handleAnnotationAdded(storedEvent as EventOfType<'mark:added'>);
        break;
      case 'mark:removed':
        await this.handleAnnotationRemoved(storedEvent as EventOfType<'mark:removed'>);
        break;
    }
  }

  private async handleResourceCreated(event: EventOfType<'yield:created'>): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));

    const rid = makeResourceId(event.resourceId!);
    const storageUri = event.payload.storageUri;
    if (!storageUri) return;

    this.logger.info('Smelter handleResourceCreated start', {
      resourceId: String(rid), storageUri,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });

    const content = await this.contentStore.retrieve(storageUri);
    if (!content) return;

    const text = new TextDecoder().decode(content);
    if (!text.trim()) return;

    const chunks = chunkText(text, this.chunkingConfig);
    if (chunks.length === 0) return;

    this.logger.info('Smelter chunked resource', {
      resourceId: String(rid), textBytes: text.length, chunkCount: chunks.length,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });

    const embeddings = await this.embeddingProvider.embedBatch(chunks);
    const model = this.embeddingProvider.model();
    const dimensions = this.embeddingProvider.dimensions();

    this.logger.info('Smelter embedded resource', {
      resourceId: String(rid), chunkCount: chunks.length, dimensions,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });

    const embeddingChunks: EmbeddingChunk[] = chunks.map((text, i) => ({
      chunkIndex: i, text, embedding: embeddings[i],
    }));

    await this.embeddingStore.writeResourceChunks(rid, model, dimensions, embeddingChunks);

    this.logger.info('Smelter wrote resource embeddings to store', {
      resourceId: String(rid), chunkCount: embeddingChunks.length,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });

    await this.vectorStore.upsertResourceVectors(rid, embeddingChunks);
    this.logger.info('Smelter indexed resource', {
      resourceId: String(rid), chunks: embeddingChunks.length,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  }

  /**
   * Re-embed a resource whose content has changed in-place.
   *
   * Used by yield:updated and yield:representation-added handlers. Reads the
   * current storageUri from the materialized view (which is updated before the
   * EventBus fires), deletes stale Qdrant vectors, and overwrites the
   * EmbeddingStore file with fresh chunks.
   */
  private async reembedResource(rid: ReturnType<typeof makeResourceId>): Promise<void> {
    const view = await this.viewStorage.get(rid);
    const storageUri = view?.resource.storageUri;
    if (!storageUri) return;

    const content = await this.contentStore.retrieve(storageUri);
    if (!content) return;

    const text = new TextDecoder().decode(content);
    if (!text.trim()) return;

    const chunks = chunkText(text, this.chunkingConfig);
    if (chunks.length === 0) return;

    const embeddings = await this.embeddingProvider.embedBatch(chunks);
    const model = this.embeddingProvider.model();
    const dimensions = this.embeddingProvider.dimensions();

    const embeddingChunks: EmbeddingChunk[] = chunks.map((chunkText, i) => ({
      chunkIndex: i, text: chunkText, embedding: embeddings[i],
    }));

    await this.embeddingStore.writeResourceChunks(rid, model, dimensions, embeddingChunks);
    // Delete-then-upsert to purge stale chunk indices if the chunk count changed
    await this.vectorStore.deleteResourceVectors(rid);
    await this.vectorStore.upsertResourceVectors(rid, embeddingChunks);

    this.logger.debug('Smelter re-embedded resource', {
      resourceId: String(rid), chunks: embeddingChunks.length,
    });
  }

  private async handleResourceUpdated(event: EventOfType<'yield:updated'>): Promise<void> {
    await this.reembedResource(makeResourceId(event.resourceId!));
  }

  private async handleRepresentationAdded(event: EventOfType<'yield:representation-added'>): Promise<void> {
    await this.reembedResource(makeResourceId(event.resourceId!));
  }

  private async handleResourceArchived(event: EventOfType<'mark:archived'>): Promise<void> {
    const rid = makeResourceId(event.resourceId!);
    await this.vectorStore.deleteResourceVectors(rid);
    await this.embeddingStore.deleteResourceEmbeddings(rid);
    this.logger.debug('Smelter deleted resource vectors', { resourceId: String(rid) });
  }

  private async handleAnnotationAdded(event: EventOfType<'mark:added'>): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));

    const annotation = event.payload.annotation;
    if (!annotation || !annotation.id) return;

    const rid = makeResourceId(event.resourceId!);
    const aid = makeAnnotationId(annotation.id);

    const selector = getTargetSelector(annotation.target);
    const exactText = getExactText(selector);
    if (!exactText || !exactText.trim()) return;

    this.logger.info('Smelter handleAnnotationAdded start', {
      annotationId: String(aid), resourceId: String(rid), textLength: exactText.length,
      heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });

    const embedding = await this.embeddingProvider.embed(exactText);
    const model = this.embeddingProvider.model();
    const dimensions = this.embeddingProvider.dimensions();
    const motivation = annotation.motivation ?? '';
    const entityTypes = ((annotation as Record<string, unknown>).entityTypes as string[] | undefined) ?? [];

    await this.embeddingStore.writeAnnotationEmbedding(
      aid, rid, model, dimensions, exactText, embedding, motivation, entityTypes,
    );

    const payload: AnnotationPayload = {
      annotationId: aid, resourceId: rid, motivation, entityTypes, exactText,
    };
    await this.vectorStore.upsertAnnotationVector(aid, embedding, payload);

    this.logger.info('Smelter indexed annotation', {
      annotationId: String(aid), resourceId: String(rid),
    });
  }

  private async handleAnnotationRemoved(event: EventOfType<'mark:removed'>): Promise<void> {
    const annotationId = String(event.payload.annotationId);
    if (!annotationId) return;

    const aid = makeAnnotationId(annotationId);

    await this.vectorStore.deleteAnnotationVector(aid);
    await this.embeddingStore.deleteAnnotationEmbedding(aid);

    this.logger.debug('Smelter deleted annotation vector', { annotationId: String(aid) });
  }
}
