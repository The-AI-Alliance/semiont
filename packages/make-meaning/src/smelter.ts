/**
 * Smelter — event-to-vector pipeline for the standalone smelter worker.
 *
 * Consumes the smelter-relevant domain events surfaced by
 * `SmelterActorStateUnit.events$`, reads resource content via the injected
 * `IContentTransport` (HTTP verbatim mode in worker deployments — the
 * stored bytes, untouched), chunks and embeds it via the configured
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
 * while the worker was down. It is a planner: it diffs the store against the
 * catalog (over the `browse:*` RPC channels) — both membership AND content
 * freshness, via the checksum stamped onto every resource upsert — and
 * enqueues `smelt:*` work items through the same mailbox as live events, so
 * per-resource ordering holds across the two paths (axioms S1/S2/S11/S12 in
 * `.plans/SMELTER-AXIOMS.md`).
 */

import { Observable, Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { burstBuffer, errField } from '@semiont/core';
import type { Logger, Annotation, ResourceId, AnnotationId, ResourceDescriptor, IContentTransport } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { getExactText, getTargetSelector, getPrimaryMediaType, getPrimaryRepresentation, decodeRepresentation, textExtractionOf } from '@semiont/core';
import { calculateChecksum } from '@semiont/content';
import type { VectorStore, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import type { EmbeddingProvider, ChunkingConfig } from '@semiont/vectors';
import { chunkText } from '@semiont/vectors';
import { withActorSpan } from '@semiont/observability';
import { busRequest, type BusRequestPrimitive } from '@semiont/sdk';
import { partitionByType } from './batch-utils';
import type { SmelterEvent } from './smelter-actor-state-unit';

// The media gate is `textExtractionOf(mediaType) === 'decode'` at both call
// sites (live fetch and reconcile planning): registry rows plus the RFC 2046
// text/* fallback — "embed anything that decodes as text" (MEDIA-TYPES.md
// decision 7). 'pdf-text-layer' types stay out until the per-type extraction
// dispatch lands (`.plans/SMELTER-MEDIA-TYPES.md`) — binary types decode to
// mojibake that pollutes the vector space.

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

/**
 * Burst-buffer timings for the event pipeline. Required — `smelter-main`
 * passes production values (50/100/200); test harnesses pass ~1ms values so
 * property suites run at generator speed. See `.plans/SMELTER-AXIOMS.md` (D4).
 */
export interface SmelterTiming {
  burstWindowMs: number;
  maxBatchSize: number;
  idleTimeoutMs: number;
}

/**
 * Reconcile-planner work items — enqueued through the same mailbox as wire
 * events. Distinct `smelt:*` types make forged domain events unrepresentable
 * (`.plans/SMELTER-AXIOMS.md`, D1); the shared shape lets the per-resource
 * lanes and batch paths serve both kinds of input.
 */
export interface SmelterWorkItem {
  type: 'smelt:embed' | 'smelt:purge' | 'smelt:embed-annotation' | 'smelt:purge-annotation';
  resourceId: string;
  payload: Record<string, unknown>;
}

export type SmelterInput = SmelterEvent | SmelterWorkItem;

function isWorkItem(input: SmelterInput): input is SmelterWorkItem {
  return input.type.startsWith('smelt:');
}

export class Smelter {
  private static readonly RECONCILE_PAGE_SIZE = 200;
  /** Bound on concurrently in-flight reconcile work — a cold rebuild must not fan out unbounded embedding calls. */
  private static readonly RECONCILE_WAVE = 8;

  private eventSubject = new Subject<SmelterInput>();
  private sourceSubscription: Subscription | null = null;
  private pipelineSubscription: Subscription | null = null;
  private _eventsProcessed = 0;
  private _reconcileState: ReconcileState = { phase: 'pending' };
  private workDone = 0;
  private workWaiter: { target: number; resolve: () => void } | null = null;

  constructor(
    private events$: Observable<SmelterEvent>,
    private vectorStore: VectorStore,
    private embeddingProvider: EmbeddingProvider,
    private content: IContentTransport,
    private bus: BusRequestPrimitive,
    private chunkingConfig: ChunkingConfig,
    private timing: SmelterTiming,
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
      groupBy((e: SmelterInput) => e.resourceId ?? '__unknown__'),
      mergeMap((group) =>
        group.pipe(
          burstBuffer<SmelterInput>({
            burstWindowMs: this.timing.burstWindowMs,
            maxBatchSize: this.timing.maxBatchSize,
            idleTimeoutMs: this.timing.idleTimeoutMs,
          }),
          concatMap((inputOrBatch: SmelterInput | SmelterInput[]) => {
            if (Array.isArray(inputOrBatch)) {
              return from(
                withActorSpan('smelter', 'batch', async () => {
                  this._eventsProcessed += await this.processBatch(inputOrBatch);
                }, { 'batch.size': inputOrBatch.length }),
              );
            }
            return from(
              withActorSpan('smelter', inputOrBatch.type, async () => {
                const ok = await this.safeProcessEvent(inputOrBatch);
                if (isWorkItem(inputOrBatch)) this.noteWorkDone(1);
                else if (ok) this._eventsProcessed++;
              }),
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

  private noteWorkDone(count: number): void {
    this.workDone += count;
    if (this.workWaiter && this.workDone >= this.workWaiter.target) {
      this.workWaiter.resolve();
      this.workWaiter = null;
    }
  }

  /**
   * Returns the number of WIRE events processed without error (the S9b
   * oracle) — `smelt:*` work-item runs tick the drain counter instead.
   */
  private async processBatch(events: SmelterInput[]): Promise<number> {
    let wireProcessed = 0;
    for (const run of partitionByType(events)) {
      const workRun = isWorkItem(run[0]);
      try {
        if (run.length === 1) {
          const ok = await this.safeProcessEvent(run[0]);
          if (ok && !workRun) wireProcessed++;
        } else {
          const processed = await this.applyBatchByType(run);
          if (!workRun) wireProcessed += processed;
        }
      } catch (error) {
        this.logger.error('Smelter failed to process batch run', {
          eventType: run[0].type,
          runSize: run.length,
          error: errField(error),
        });
      } finally {
        if (workRun) this.noteWorkDone(run.length);
      }
    }
    return wireProcessed;
  }

  /**
   * Batch-optimized processing for consecutive events of the same type.
   * Returns the number of events processed without error.
   */
  private async applyBatchByType(events: SmelterInput[]): Promise<number> {
    switch (events[0].type) {
      case 'yield:created':
      case 'smelt:embed':
        return this.batchResourceCreated(events);
      case 'mark:added':
      case 'smelt:embed-annotation':
        return this.batchAnnotationAdded(events);
      default: {
        let processed = 0;
        for (const event of events) {
          if (await this.safeProcessEvent(event)) processed++;
        }
        return processed;
      }
    }
  }

  /** Returns true if the input was processed without error. */
  private async safeProcessEvent(event: SmelterInput): Promise<boolean> {
    try {
      await this.processEvent(event);
      return true;
    } catch (err) {
      this.logger.error('Smelter failed to process event', {
        type: event.type,
        resourceId: event.resourceId,
        error: errField(err),
      });
      return false;
    }
  }

  private async processEvent(event: SmelterInput): Promise<void> {
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
      // Reconcile work items — same handlers, distinct provenance.
      case 'smelt:embed':
        await this.embedResource(event, 'Reconcile-indexed resource');
        break;
      case 'smelt:purge':
        await this.handleResourcePurge(event);
        break;
      case 'smelt:embed-annotation':
        await this.handleAnnotationAdded(event);
        break;
      case 'smelt:purge-annotation':
        await this.handleAnnotationRemoved(event);
        break;
    }
  }

  private async handleResourcePurge(event: SmelterInput): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;
    await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
    this.logger.info('Reconcile deleted orphan resource vectors', { resourceId: rid });
  }

  /**
   * Resolve a resource's embeddable text: bytes via the content transport,
   * gated to media types that decode as text, decoded charset-aware. The
   * checksum is over the raw bytes actually read — stamped onto the vectors
   * so reconciliation can compare against the catalog's claim (S12). Returns
   * null (logged) when the resource doesn't decode as text, is unavailable,
   * or is empty — callers skip it.
   */
  private async fetchEmbeddableText(resourceId: string): Promise<{ text: string; checksum: string } | null> {
    try {
      // The stored representation's bytes, untouched — the content route is a
      // pure pipe now (no negotiation), so getBinary returns exactly the bytes
      // the catalog's checksum was computed from (S12; the route-side half is
      // the backend's resource-raw-mode lemma test).
      const { data, contentType } = await this.content.getBinary(makeResourceId(resourceId));
      if (textExtractionOf(contentType) !== 'decode') {
        this.logger.debug('Skipping resource that does not decode as text', { resourceId, contentType });
        return null;
      }
      const bytes = Buffer.from(data);
      const text = decodeRepresentation(bytes, contentType);
      return text.trim() ? { text, checksum: calculateChecksum(bytes) } : null;
    } catch (error) {
      this.logger.warn('Content unavailable for embedding', { resourceId, error: errField(error) });
      return null;
    }
  }

  private async embedResource(event: SmelterInput, logMessage: string): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;

    const fetched = await this.fetchEmbeddableText(rid);
    if (!fetched) return;

    const chunks = chunkText(fetched.text, this.chunkingConfig);
    if (chunks.length === 0) return;

    const embeddings = await this.embeddingProvider.embedBatch(chunks);
    const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
      chunkIndex: i, text: t, embedding: embeddings[i],
    }));

    await this.vectorStore.upsertResourceVectors(makeResourceId(rid), embeddingChunks, fetched.checksum);
    this.logger.info(logMessage, { resourceId: rid, chunks: chunks.length });
  }

  private async handleResourceArchived(event: SmelterInput): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;
    await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
    // Annotations anchored to an archived resource must not surface in
    // search either — and reconcile() treats them as orphans, so deleting
    // them here keeps the live path and a restart in agreement.
    await this.vectorStore.deleteAnnotationVectorsForResource(makeResourceId(rid));
    this.logger.info('Deleted vectors for archived resource', { resourceId: rid });
  }

  private async handleAnnotationAdded(event: SmelterInput): Promise<void> {
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

  private async handleAnnotationRemoved(event: SmelterInput): Promise<void> {
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
  private async batchResourceCreated(events: SmelterInput[]): Promise<number> {
    const resourceData: { rid: ResourceId; chunks: string[]; checksum: string }[] = [];
    const allChunks: string[] = [];

    for (const event of events) {
      const rid = event.resourceId;
      if (!rid) continue;

      const fetched = await this.fetchEmbeddableText(rid);
      if (!fetched) continue;

      const chunks = chunkText(fetched.text, this.chunkingConfig);
      if (chunks.length === 0) continue;

      resourceData.push({ rid: makeResourceId(rid), chunks, checksum: fetched.checksum });
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) return events.length;

    const allEmbeddings = await this.embeddingProvider.embedBatch(allChunks);

    let offset = 0;
    for (const { rid, chunks, checksum } of resourceData) {
      const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
        chunkIndex: i, text: t, embedding: allEmbeddings[offset + i],
      }));
      await this.vectorStore.upsertResourceVectors(rid, embeddingChunks, checksum);
      this.logger.info('Batch-indexed resource', { resourceId: String(rid), chunks: chunks.length });
      offset += chunks.length;
    }

    return events.length;
  }

  /**
   * Batch-embed exact texts from multiple mark:added events in a single
   * embedBatch() call, then index per annotation.
   */
  private async batchAnnotationAdded(events: SmelterInput[]): Promise<number> {
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

    if (annotationData.length === 0) return events.length;

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

    return events.length;
  }

  // ── Reconciliation ───────────────────────────────────────────────────

  /**
   * Reconcile the vector store against the KS catalog.
   *
   * Lists what IS indexed (via the store's id enumeration) and what SHOULD
   * be (non-archived resources with embeddable media types, plus their
   * exact-text annotations, via the `browse:*` RPC channels), then plans the
   * diff as `smelt:*` work items — embeds for what's missing, purges for
   * what shouldn't be there — and drains them through the pipeline mailbox.
   * Work items share the per-resource lanes with live events, so a reconcile
   * re-embed can never interleave with (or stale-overwrite) live processing
   * of the same resource (axioms S1/S2). Waves of RECONCILE_WAVE bound how
   * many embedding calls a cold rebuild has in flight.
   *
   * Call after the live subscription is attached so nothing falls in the
   * gap. The index snapshot is taken BEFORE the catalog listing so a
   * resource indexed by a live event mid-reconcile is never mistaken for an
   * orphan; convergence holds because every upsert replaces a resource's
   * full vector set from current content.
   */
  async reconcile(): Promise<ReconcileSummary> {
    if (!this.pipelineSubscription) {
      throw new Error('Smelter.reconcile() requires initialize() — work items drain through the pipeline');
    }
    this._reconcileState = { phase: 'running' };
    try {
      const [indexedResources, indexedAnnotations] = await Promise.all([
        this.vectorStore.listResourceChecksums(),
        this.vectorStore.listAnnotationIds(),
      ]);
      const resources = await this.listAllResources();
      this.logger.info('Reconcile started', {
        indexedResources: indexedResources.size,
        indexedAnnotations: indexedAnnotations.size,
        liveResources: resources.length,
      });

      // Embeddable live resources, each with the catalog's claim about its
      // primary representation's checksum (the bytes the smelter would read).
      const embeddable = new Map<string, string | undefined>();
      for (const resource of resources) {
        const mediaType = getPrimaryMediaType(resource);
        if (resource['@id'] && mediaType && textExtractionOf(mediaType) === 'decode') {
          embeddable.set(resource['@id'], getPrimaryRepresentation(resource)?.checksum);
        }
      }

      const work: SmelterWorkItem[] = [];

      for (const rid of indexedResources.keys()) {
        if (!embeddable.has(rid)) work.push({ type: 'smelt:purge', resourceId: rid, payload: {} });
      }
      for (const [rid, catalogChecksum] of embeddable) {
        if (!indexedResources.has(rid)) {
          work.push({ type: 'smelt:embed', resourceId: rid, payload: {} });
        } else if (catalogChecksum !== undefined && indexedResources.get(rid) !== catalogChecksum) {
          // Stale-but-present: indexed from earlier bytes (or from a pre-stamp
          // deployment, where the stamp reads as undefined) — re-embed (S12).
          work.push({ type: 'smelt:embed', resourceId: rid, payload: {} });
        }
      }

      // Annotations: every live resource is consulted — not just the
      // re-embedded ones — so orphan detection sees the full live set.
      const liveAnnotationIds = new Set<string>();
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
            work.push({ type: 'smelt:embed-annotation', resourceId: rid, payload: { annotation } });
          }
        }
      }

      for (const aid of indexedAnnotations) {
        if (!liveAnnotationIds.has(aid)) {
          // An orphan's anchor is unknown — the annotation no longer exists
          // in the catalog — so the orphan's own id keys its lane.
          work.push({ type: 'smelt:purge-annotation', resourceId: aid, payload: { annotationId: aid } });
        }
      }

      await this.drain(work);

      const summary: ReconcileSummary = {
        resourcesEmbedded: work.filter((w) => w.type === 'smelt:embed').length,
        resourceVectorsDeleted: work.filter((w) => w.type === 'smelt:purge').length,
        annotationsEmbedded: work.filter((w) => w.type === 'smelt:embed-annotation').length,
        annotationVectorsDeleted: work.filter((w) => w.type === 'smelt:purge-annotation').length,
      };
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

  /**
   * Enqueue planner work through the mailbox in bounded waves and await
   * completion. The pipeline ticks `noteWorkDone` for every consumed work
   * item (success or failure — failures are logged like any live event), so
   * each wave's waiter resolves exactly when its items have been processed.
   */
  private async drain(work: SmelterWorkItem[]): Promise<void> {
    for (let i = 0; i < work.length; i += Smelter.RECONCILE_WAVE) {
      const wave = work.slice(i, i + Smelter.RECONCILE_WAVE);
      const done = new Promise<void>((resolve) => {
        this.workWaiter = { target: this.workDone + wave.length, resolve };
      });
      for (const item of wave) this.eventSubject.next(item);
      await done;
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
