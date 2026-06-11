/**
 * Smelter — event-to-vector pipeline for the standalone smelter worker.
 *
 * Consumes the smelter-relevant domain events surfaced by
 * `SmelterActorStateUnit.events$`, reads resource content via the injected
 * `IContentTransport` (direct working-tree reads in worker mode — see
 * `WorkerContentTransport`), chunks and embeds it via the configured
 * EmbeddingProvider, and indexes vectors into the VectorStore (Qdrant).
 * `smelter-main` is the container entry point that wires this up.
 *
 * ## Per-resource serialization
 *
 * Smelter processes events strictly in order per resourceId via
 * `groupBy(resourceId) + concatMap(...)`. This is the stream-consumer
 * flavor of per-resource serialization — the same invariant enforced by
 * `GraphDBConsumer`, `Gatherer`, and (in a different shape) `ViewManager`.
 * See `packages/core/src/serialize-per-key.ts` for the shared primitive
 * used by RPC-style services.
 *
 * ## Batching
 *
 * `burstBuffer` collects event bursts per resource; consecutive same-type
 * runs within a burst share a single `embedBatch()` call.
 *
 * ## Reconciliation
 *
 * Qdrant is an ephemeral projection of the event log. `reconcile()` brings
 * it back in sync at startup — after a wiped volume, or after events missed
 * while the worker was down. See the method doc for the algorithm.
 */

import { Observable, Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { burstBuffer, errField } from '@semiont/core';
import type { Logger, Annotation, ResourceId, AnnotationId, ResourceDescriptor, IContentTransport } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { getExactText, getTargetSelector, getPrimaryMediaType, decodeRepresentation } from '@semiont/core';
import type { VectorStore, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import type { EmbeddingProvider, ChunkingConfig } from '@semiont/vectors';
import { chunkText } from '@semiont/vectors';
import { withActorSpan } from '@semiont/observability';
import { busRequest, type BusRequestPrimitive } from '@semiont/sdk';
import { partitionByType } from './batch-utils';
import type { SmelterEvent } from './smelter-actor-state-unit';

/**
 * Media types the smelter embeds. Binary types decode to mojibake that
 * pollutes the vector space — PDF foremost; see
 * `.plans/SMELTER-MEDIA-TYPES.md` for the extraction stage that will
 * eventually let them carry analytical weight too.
 */
export function isEmbeddableMediaType(mediaType: string | undefined): boolean {
  return !!mediaType && mediaType.startsWith('text/');
}

export interface ReconcileSummary {
  resourcesEmbedded: number;
  resourceVectorsDeleted: number;
  annotationsEmbedded: number;
  annotationVectorsDeleted: number;
}

export type ReconcileState =
  | { phase: 'pending' }
  | { phase: 'running' }
  | { phase: 'done'; summary: ReconcileSummary }
  | { phase: 'failed'; error: string };

export class Smelter {
  private static readonly BURST_WINDOW_MS = 50;
  private static readonly MAX_BATCH_SIZE = 100;
  private static readonly IDLE_TIMEOUT_MS = 200;
  private static readonly RECONCILE_PAGE_SIZE = 200;

  private eventSubject = new Subject<SmelterEvent>();
  private sourceSubscription: Subscription | null = null;
  private pipelineSubscription: Subscription | null = null;
  private _eventsProcessed = 0;
  private _reconcileState: ReconcileState = { phase: 'pending' };

  constructor(
    private events$: Observable<SmelterEvent>,
    private vectorStore: VectorStore,
    private embeddingProvider: EmbeddingProvider,
    private content: IContentTransport,
    private bus: BusRequestPrimitive,
    private chunkingConfig: ChunkingConfig,
    private logger: Logger,
  ) {}

  get eventsProcessed(): number {
    return this._eventsProcessed;
  }

  get reconcileState(): ReconcileState {
    return this._reconcileState;
  }

  initialize(): void {
    this.pipelineSubscription = this.eventSubject.pipe(
      groupBy((e: SmelterEvent) => e.resourceId ?? '__unknown__'),
      mergeMap((group) =>
        group.pipe(
          burstBuffer<SmelterEvent>({
            burstWindowMs: Smelter.BURST_WINDOW_MS,
            maxBatchSize: Smelter.MAX_BATCH_SIZE,
            idleTimeoutMs: Smelter.IDLE_TIMEOUT_MS,
          }),
          concatMap((eventOrBatch: SmelterEvent | SmelterEvent[]) => {
            if (Array.isArray(eventOrBatch)) {
              return from(
                withActorSpan('smelter', 'batch', () => this.processBatch(eventOrBatch), {
                  'batch.size': eventOrBatch.length,
                }),
              );
            }
            return from(
              withActorSpan('smelter', eventOrBatch.type, () => this.safeProcessEvent(eventOrBatch)),
            );
          }),
        ),
      ),
    ).subscribe({
      error: (err) => this.logger.error('Smelter pipeline error', { error: errField(err) }),
    });

    this.sourceSubscription = this.events$.subscribe((event) => {
      this.logger.debug('Bus event received', { type: event.type, resourceId: event.resourceId });
      this.eventSubject.next(event);
    });

    this.logger.info('Smelter pipeline initialized');
  }

  stop(): void {
    this.sourceSubscription?.unsubscribe();
    this.sourceSubscription = null;
    this.pipelineSubscription?.unsubscribe();
    this.pipelineSubscription = null;
    this.eventSubject.complete();
    this.logger.info('Smelter stopped');
  }

  private async processBatch(events: SmelterEvent[]): Promise<void> {
    for (const run of partitionByType(events)) {
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
          error: errField(error),
        });
      }
    }
  }

  /**
   * Batch-optimized processing for consecutive events of the same type.
   */
  private async applyBatchByType(events: SmelterEvent[]): Promise<void> {
    switch (events[0].type) {
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

  private async safeProcessEvent(event: SmelterEvent): Promise<void> {
    try {
      await this.processEvent(event);
      this._eventsProcessed++;
    } catch (err) {
      this.logger.error('Smelter failed to process event', {
        type: event.type,
        resourceId: event.resourceId,
        error: errField(err),
      });
    }
  }

  private async processEvent(event: SmelterEvent): Promise<void> {
    switch (event.type) {
      case 'yield:created':
        await this.embedResource(event, 'Indexed resource');
        break;
      case 'yield:updated':
      case 'yield:representation-added':
        await this.embedResource(event, 'Re-embedded resource');
        break;
      case 'mark:archived':
        await this.handleResourceArchived(event);
        break;
      case 'mark:added':
        await this.handleAnnotationAdded(event);
        break;
      case 'mark:removed':
        await this.handleAnnotationRemoved(event);
        break;
    }
  }

  /**
   * Resolve a resource's embeddable text: bytes via the content transport,
   * gated to text media types, decoded charset-aware. Returns null (logged)
   * when the resource is non-text, unavailable, or empty — callers skip it.
   */
  private async fetchEmbeddableText(resourceId: string): Promise<string | null> {
    try {
      const { data, contentType } = await this.content.getBinary(makeResourceId(resourceId));
      if (!isEmbeddableMediaType(contentType)) {
        this.logger.debug('Skipping non-text resource', { resourceId, contentType });
        return null;
      }
      const text = decodeRepresentation(Buffer.from(data), contentType);
      return text.trim() ? text : null;
    } catch (error) {
      this.logger.warn('Content unavailable for embedding', { resourceId, error: errField(error) });
      return null;
    }
  }

  private async embedResource(event: SmelterEvent, logMessage: string): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;

    const text = await this.fetchEmbeddableText(rid);
    if (!text) return;

    const chunks = chunkText(text, this.chunkingConfig);
    if (chunks.length === 0) return;

    const embeddings = await this.embeddingProvider.embedBatch(chunks);
    const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
      chunkIndex: i, text: t, embedding: embeddings[i],
    }));

    await this.vectorStore.upsertResourceVectors(makeResourceId(rid), embeddingChunks);
    this.logger.info(logMessage, { resourceId: rid, chunks: chunks.length });
  }

  private async handleResourceArchived(event: SmelterEvent): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;
    await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
    // Annotations anchored to an archived resource must not surface in
    // search either — and reconcile() treats them as orphans, so deleting
    // them here keeps the live path and a restart in agreement.
    await this.vectorStore.deleteAnnotationVectorsForResource(makeResourceId(rid));
    this.logger.info('Deleted vectors for archived resource', { resourceId: rid });
  }

  private async handleAnnotationAdded(event: SmelterEvent): Promise<void> {
    const annotation = event.payload.annotation as Annotation | undefined;
    if (!annotation?.id) return;

    const rid = event.resourceId;
    if (!rid) return;

    const selector = getTargetSelector(annotation.target);
    const exactText = getExactText(selector);
    if (!exactText?.trim()) return;

    const aid = makeAnnotationId(annotation.id);
    const embedding = await this.embeddingProvider.embed(exactText);

    const payload: AnnotationPayload = {
      annotationId: aid,
      resourceId: makeResourceId(rid),
      motivation: annotation.motivation ?? '',
      entityTypes: ((annotation as Record<string, unknown>).entityTypes as string[] | undefined) ?? [],
      exactText,
    };
    await this.vectorStore.upsertAnnotationVector(aid, embedding, payload);
    this.logger.info('Indexed annotation', { annotationId: String(aid) });
  }

  private async handleAnnotationRemoved(event: SmelterEvent): Promise<void> {
    const annotationId = event.payload.annotationId as string | undefined;
    if (!annotationId) return;
    const aid = makeAnnotationId(annotationId);
    await this.vectorStore.deleteAnnotationVector(aid);
    this.logger.info('Deleted annotation vector', { annotationId });
  }

  /**
   * Batch-embed chunks from multiple yield:created events in a single
   * embedBatch() call, then index per resource.
   */
  private async batchResourceCreated(events: SmelterEvent[]): Promise<void> {
    const resourceData: { rid: ResourceId; chunks: string[] }[] = [];
    const allChunks: string[] = [];

    for (const event of events) {
      const rid = event.resourceId;
      if (!rid) continue;

      const text = await this.fetchEmbeddableText(rid);
      if (!text) continue;

      const chunks = chunkText(text, this.chunkingConfig);
      if (chunks.length === 0) continue;

      resourceData.push({ rid: makeResourceId(rid), chunks });
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) return;

    const allEmbeddings = await this.embeddingProvider.embedBatch(allChunks);

    let offset = 0;
    for (const { rid, chunks } of resourceData) {
      const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
        chunkIndex: i, text: t, embedding: allEmbeddings[offset + i],
      }));
      await this.vectorStore.upsertResourceVectors(rid, embeddingChunks);
      this.logger.info('Batch-indexed resource', { resourceId: String(rid), chunks: chunks.length });
      offset += chunks.length;
    }

    this._eventsProcessed += events.length;
  }

  /**
   * Batch-embed exact texts from multiple mark:added events in a single
   * embedBatch() call, then index per annotation.
   */
  private async batchAnnotationAdded(events: SmelterEvent[]): Promise<void> {
    const annotationData: {
      rid: ResourceId;
      aid: AnnotationId;
      exactText: string;
      motivation: string;
      entityTypes: string[];
    }[] = [];

    for (const event of events) {
      const annotation = event.payload.annotation as Annotation | undefined;
      if (!annotation?.id) continue;

      const rid = event.resourceId;
      if (!rid) continue;

      const selector = getTargetSelector(annotation.target);
      const exactText = getExactText(selector);
      if (!exactText?.trim()) continue;

      annotationData.push({
        rid: makeResourceId(rid),
        aid: makeAnnotationId(annotation.id),
        exactText,
        motivation: annotation.motivation ?? '',
        entityTypes: ((annotation as Record<string, unknown>).entityTypes as string[] | undefined) ?? [],
      });
    }

    if (annotationData.length === 0) return;

    const allEmbeddings = await this.embeddingProvider.embedBatch(
      annotationData.map((a) => a.exactText),
    );

    for (let i = 0; i < annotationData.length; i++) {
      const { rid, aid, exactText, motivation, entityTypes } = annotationData[i];
      const payload: AnnotationPayload = {
        annotationId: aid, resourceId: rid, motivation, entityTypes, exactText,
      };
      await this.vectorStore.upsertAnnotationVector(aid, allEmbeddings[i], payload);
      this.logger.info('Batch-indexed annotation', { annotationId: String(aid) });
    }

    this._eventsProcessed += events.length;
  }

  // ── Reconciliation ───────────────────────────────────────────────────

  /**
   * Reconcile the vector store against the KS catalog.
   *
   * Lists what IS indexed (via the store's id enumeration) and what SHOULD
   * be (non-archived resources with embeddable media types, plus their
   * exact-text annotations, via the `browse:*` RPC channels), then
   * re-embeds what's missing and deletes what shouldn't be there — vectors
   * for resources that were hard-deleted, archived while the worker was
   * down, or whose media type the smelter no longer embeds.
   *
   * Call after the live subscription is attached so nothing falls in the
   * gap. Runs beside the live pipeline rather than through it: re-embeds
   * are sequential (one embedding call in flight — the same per-resource
   * call shape as the live path), and the two paths converge because every
   * upsert replaces a resource's full vector set from current content.
   * The index snapshot is taken BEFORE the catalog listing so a resource
   * indexed by a live event mid-reconcile is never mistaken for an orphan.
   */
  async reconcile(): Promise<ReconcileSummary> {
    this._reconcileState = { phase: 'running' };
    try {
      const [indexedResources, indexedAnnotations] = await Promise.all([
        this.vectorStore.listResourceIds(),
        this.vectorStore.listAnnotationIds(),
      ]);
      const resources = await this.listAllResources();
      this.logger.info('Reconcile started', {
        indexedResources: indexedResources.size,
        indexedAnnotations: indexedAnnotations.size,
        liveResources: resources.length,
      });

      const summary: ReconcileSummary = {
        resourcesEmbedded: 0,
        resourceVectorsDeleted: 0,
        annotationsEmbedded: 0,
        annotationVectorsDeleted: 0,
      };

      const embeddableIds = new Set<string>();
      for (const resource of resources) {
        if (resource['@id'] && isEmbeddableMediaType(getPrimaryMediaType(resource))) {
          embeddableIds.add(resource['@id']);
        }
      }

      for (const rid of indexedResources) {
        if (embeddableIds.has(rid)) continue;
        await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
        summary.resourceVectorsDeleted++;
      }

      for (const rid of embeddableIds) {
        if (indexedResources.has(rid)) continue;
        await this.safeProcessEvent({ type: 'yield:created', resourceId: rid, payload: {} });
        summary.resourcesEmbedded++;
      }

      // Annotations: every live resource is consulted — not just the
      // re-embedded ones — so orphan detection sees the full live set.
      const liveAnnotationIds = new Set<string>();
      const missing: SmelterEvent[] = [];
      for (const resource of resources) {
        const rid = resource['@id'];
        if (!rid) continue;
        const { annotations } = await busRequest<{ annotations: Annotation[] }>(
          this.bus,
          'browse:annotations-requested',
          { resourceId: rid },
          'browse:annotations-result',
          'browse:annotations-failed',
        );
        for (const annotation of annotations) {
          const exactText = getExactText(getTargetSelector(annotation.target));
          if (!annotation.id || !exactText?.trim()) continue;
          liveAnnotationIds.add(annotation.id);
          if (!indexedAnnotations.has(annotation.id)) {
            missing.push({ type: 'mark:added', resourceId: rid, payload: { resourceId: rid, annotation } });
          }
        }
      }

      for (let i = 0; i < missing.length; i += Smelter.MAX_BATCH_SIZE) {
        const slice = missing.slice(i, i + Smelter.MAX_BATCH_SIZE);
        try {
          await this.batchAnnotationAdded(slice);
          summary.annotationsEmbedded += slice.length;
        } catch (error) {
          this.logger.error('Reconcile failed to embed annotation slice', {
            runSize: slice.length,
            error: errField(error),
          });
        }
      }

      for (const aid of indexedAnnotations) {
        if (liveAnnotationIds.has(aid)) continue;
        await this.vectorStore.deleteAnnotationVector(makeAnnotationId(aid));
        summary.annotationVectorsDeleted++;
      }

      this._reconcileState = { phase: 'done', summary };
      this.logger.info('Reconcile complete', { ...summary });
      return summary;
    } catch (error) {
      this._reconcileState = {
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      this.logger.error('Reconcile failed', { error: errField(error) });
      throw error;
    }
  }

  /** Page through `browse:resources-requested` until the catalog is exhausted. */
  private async listAllResources(): Promise<ResourceDescriptor[]> {
    const all: ResourceDescriptor[] = [];
    for (;;) {
      const page = await busRequest<{ resources: ResourceDescriptor[]; total: number }>(
        this.bus,
        'browse:resources-requested',
        { archived: false, offset: all.length, limit: Smelter.RECONCILE_PAGE_SIZE },
        'browse:resources-result',
        'browse:resources-failed',
      );
      all.push(...page.resources);
      if (page.resources.length === 0 || all.length >= page.total) return all;
    }
  }
}
