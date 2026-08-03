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
 * `Weaver`, `Gatherer`, and (in a different shape) `ViewManager`.
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
 * catalog (over the `browse:*` RPC channels) — membership, content freshness
 * (via the checksum stamped onto every resource upsert), and tag-stamp
 * freshness (payload-only restamps; tag edits change no bytes) — and
 * enqueues `smelt:*` work items through the same mailbox as live events, so
 * per-resource ordering holds across the two paths (axioms S1/S2/S11/S12/S13
 * in `.plans/SMELTER-AXIOMS.md`).
 */

import { Observable, Subject, Subscription, from } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { burstBuffer, errField } from '@semiont/core';
import type { Logger, Annotation, ResourceId, AnnotationId, ResourceDescriptor, IContentTransport, EventMap } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { getExactText, getTargetSelector, getPrimaryMediaType, getPrimaryRepresentation, getResourceEntityTypes, textExtractionOf } from '@semiont/core';
import { calculateChecksum, EXTRACTORS } from '@semiont/content';
import type { VectorStore, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { ChunkingConfig } from '@semiont/core';
import { chunkText } from '@semiont/core';
import { withActorSpan } from '@semiont/observability';
import { busRequest, type BusRequestPrimitive } from '@semiont/core';
import { partitionByType } from './batch-utils';
import type { SmelterEvent } from './smelter-actor-state-unit';

// Media dispatch is the strategy-keyed extractor registry
// (`.plans/SMELTER-MEDIA-TYPES.md`): both call sites (live fetch and
// reconcile planning) resolve `EXTRACTORS[textExtractionOf(mediaType)]`,
// and a null slot declines — settle skipped, reason 'no-extractor' — so
// binary types never decode to mojibake. 'decode' is the charset-aware
// passthrough (RFC 2046 text/* fallback included); 'pdf-text-layer'
// extracts native text layers inline and declines scanned/encrypted/
// corrupt PDFs with their class reason (Phase 3 turns 'no-text-layer'
// declines into OCR coverage).

export interface ReconcileSummary {
  resourcesEmbedded: number;
  /** Tag-only drift healed by payload restamps — never embedding calls (S13). */
  resourcesRestamped: number;
  /** Lost anchored-text artifacts re-derived by re-extraction — never
   *  embedding calls (PERSIST-ANCHORS P0, the third drift class). */
  resourcesReanchored: number;
  resourceVectorsDeleted: number;
  annotationsEmbedded: number;
  annotationVectorsDeleted: number;
  /** Live resources whose media type has an extractor — the coverage
   *  denominator (SMELTER-MEDIA-TYPES extraction-coverage). */
  resourcesEligible: number;
  /** Resources with vectors after the drain — the coverage numerator;
   *  eligible − indexed is the decline gap. */
  resourcesIndexed: number;
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
  type: 'smelt:embed' | 'smelt:restamp' | 'smelt:reanchor' | 'smelt:purge' | 'smelt:embed-annotation' | 'smelt:purge-annotation';
  resourceId: string;
  payload: Record<string, unknown>;
}

/** Set equality over tag lists — order-insensitive, duplicate-tolerant. */
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((t) => set.has(t));
}

export type SmelterInput = SmelterEvent | SmelterWorkItem;

const WORK_ITEM_TYPES: ReadonlySet<string> = new Set<SmelterWorkItem['type']>([
  'smelt:embed', 'smelt:restamp', 'smelt:reanchor', 'smelt:purge', 'smelt:embed-annotation', 'smelt:purge-annotation',
]);

function isWorkItem(input: SmelterInput): input is SmelterWorkItem {
  // Literal set, not a prefix match: `smelt:settled` is the Smelter's
  // OUTBOUND decision signal (never a mailbox input) and must not read as
  // work (SMELTER-INDEX-SYNC A1).
  return WORK_ITEM_TYPES.has(input.type);
}

/**
 * Outcome of a content fetch on the embed path. `skipped` carries the
 * checksum of the bytes inspected so the settled signal stays content-keyed
 * (SMELTER-INDEX-SYNC D2); `unavailable` is a transient failure and MUST NOT
 * settle — an error is not a decision (A2).
 */
/** The decline vocabulary of the settled signal — derived from the wire
 *  type so the bus registry stays the single source of truth. */
type SkipReason = NonNullable<EventMap['smelt:settled']['reason']>;

type FetchedContent =
  | { kind: 'text'; text: string; checksum: string; machineRead: boolean }
  | { kind: 'skipped'; checksum: string; reason: SkipReason }
  | { kind: 'unavailable' };

export class Smelter {
  private static readonly RECONCILE_PAGE_SIZE = 200;
  /** Bound on concurrently in-flight reconcile work — a cold rebuild must not fan out unbounded embedding calls. */
  private static readonly RECONCILE_WAVE = 8;

  private eventSubject = new Subject<SmelterInput>();
  private sourceSubscription: Subscription | null = null;
  private commandSubscription: Subscription | null = null;
  private pipelineSubscription: Subscription | null = null;
  private _eventsProcessed = 0;
  private _reconcileState: ReconcileState = { phase: 'pending' };
  private workDone = 0;
  private workFailed = 0;
  private workWaiter: { target: number; resolve: () => void } | null = null;
  /**
   * Serializes every planner drain (reconcile, anchored-text rebuilds):
   * there is one waiter slot, and the weave:rebuild rule — rebuilds never
   * interleave — applies to every unit here being a potential multi-second
   * OCR pass.
   */
  private drainChain: Promise<void> = Promise.resolve();

  constructor(
    private events$: Observable<SmelterEvent>,
    /** `smelt:rebuild-anchors` commands — a separate stream, never the event mailbox (see SmelterActorStateUnit). */
    private rebuildAnchors$: Observable<EventMap['smelt:rebuild-anchors']>,
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
                if (isWorkItem(inputOrBatch)) this.noteWorkDone(1, ok ? 0 : 1);
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

    // Commands serialize through concatMap (rebuilds never interleave);
    // rebuildAnchors() never rejects, so the stream survives every outcome.
    this.commandSubscription = this.rebuildAnchors$.pipe(
      concatMap((command) => from(this.rebuildAnchors(command))),
    ).subscribe({
      error: (err) => this.logger.error('Smelter command pipeline error', { error: errField(err) }),
    });

    this.logger.info('Smelter pipeline initialized');
  }

  stop(): void {
    this.sourceSubscription?.unsubscribe();
    this.sourceSubscription = null;
    this.commandSubscription?.unsubscribe();
    this.commandSubscription = null;
    this.pipelineSubscription?.unsubscribe();
    this.pipelineSubscription = null;
    this.eventSubject.complete();
    this.logger.info('Smelter stopped');
  }

  private noteWorkDone(count: number, failed: number): void {
    this.workDone += count;
    this.workFailed += failed;
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
      // Per-run success accounting. Exact on the sequential paths (single
      // items and the applyBatchByType default case — which is where
      // `smelt:reanchor` runs, so the rebuild command's partial-failure
      // reply is exact); the embed batch paths count a run that returned
      // as fully succeeded, with per-item skips logged where they happen.
      let succeeded = 0;
      try {
        if (run.length === 1) {
          const ok = await this.safeProcessEvent(run[0]);
          if (ok) succeeded = 1;
          if (ok && !workRun) wireProcessed++;
        } else {
          const processed = await this.applyBatchByType(run);
          succeeded = processed;
          if (!workRun) wireProcessed += processed;
        }
      } catch (error) {
        this.logger.error('Smelter failed to process batch run', {
          eventType: run[0].type,
          runSize: run.length,
          error: errField(error),
        });
      } finally {
        if (workRun) this.noteWorkDone(run.length, run.length - succeeded);
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
      case 'mark:unarchived':
        await this.handleResourceUnarchived(event);
        break;
      case 'mark:added':
        await this.handleAnnotationAdded(event);
        break;
      case 'mark:removed':
        await this.handleAnnotationRemoved(event);
        break;
      case 'mark:entity-tag-added':
      case 'mark:entity-tag-removed':
        await this.restampResource(event);
        break;
      // Reconcile work items — same handlers, distinct provenance.
      case 'smelt:embed':
        await this.embedResource(event, 'Reconcile-indexed resource');
        break;
      case 'smelt:restamp':
        await this.restampResource(event);
        break;
      case 'smelt:reanchor':
        await this.reanchorResource(event);
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

  /**
   * Payload-only stamp refresh: re-read the resource's CURRENT entity types
   * (one code path — `resolveEntityTypes` — so any prior drift self-corrects
   * on first touch) and rewrite the stamp on its existing points. Never calls
   * the embedding provider (S13): content is unchanged by definition on every
   * path that lands here. A resource with no points is a no-op — the stamp
   * rides the next embed.
   */
  private async restampResource(event: SmelterInput): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;
    const entityTypes = await this.resolveEntityTypes(rid);
    await this.vectorStore.updateResourceEntityTypes(makeResourceId(rid), entityTypes);
    this.logger.info('Restamped resource entity types', { resourceId: rid, entityTypes });
  }

  /**
   * Re-derive a lost anchored-text artifact from the resource's current
   * bytes (PERSIST-ANCHORS P0, the third drift class). Extraction is the
   * cost here — the vectors are already correct, so this NEVER calls the
   * embedding provider, the vector store, or the settled signal: the index
   * decision was already made and announced at its checksum; only the map
   * is missing. Name the work for what it does (the S13 discipline).
   *
   * The publish is STRICT, unlike the embed path's best-effort side
   * publish: here the artifact IS the job, so a store failure must throw —
   * the pipeline logs and counts it, and the rebuild command's partial-
   * failure accounting depends on that throw.
   */
  private async reanchorResource(event: SmelterInput): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;
    const { data, contentType } = await this.content.getBinary(makeResourceId(rid));
    const bytes = Buffer.from(data);
    const extractor = EXTRACTORS[textExtractionOf(contentType)];
    if (!extractor?.yieldsGeometry) {
      // Planned from a catalog claim the bytes no longer match — nothing to
      // derive is a decision, not a failure.
      this.logger.info('Re-anchor found no geometry-capable extractor', { resourceId: rid, contentType });
      return;
    }
    // The artifact's key is the checksum of the bytes just read (P1b) — never
    // the catalog's claim, so a byte change racing this re-derivation files
    // the map under the bytes it actually describes.
    const checksum = calculateChecksum(bytes);
    const extracted = await extractor.extract(bytes, contentType);
    if ('declined' in extracted || !extracted.items?.length) {
      this.logger.info('Re-anchor extraction yielded no geometry', {
        resourceId: rid,
        contentType,
        ...('declined' in extracted ? { declined: extracted.declined } : {}),
      });
      return;
    }
    // The whole outcome, provenance included — the stored record IS the
    // extraction outcome (PERSIST-ANCHORS D1); narrowing to { text, items }
    // here would strip method/pdfClass/ocrConfidence on every rebuild.
    await this.content.putAnchoredText(checksum, { ...extracted, items: extracted.items });
    this.logger.info('Re-anchored resource', { resourceId: rid, checksum, items: extracted.items.length });
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
  private async fetchEmbeddableText(resourceId: string): Promise<FetchedContent> {
    try {
      // The stored representation's bytes, untouched — the content route is a
      // pure pipe now (no negotiation), so getBinary returns exactly the bytes
      // the catalog's checksum was computed from (S12; the route-side half is
      // the backend's resource-raw-mode lemma test). The checksum is computed
      // before the media gate so `skipped` decisions stay content-keyed (D2).
      const { data, contentType } = await this.content.getBinary(makeResourceId(resourceId));
      const bytes = Buffer.from(data);
      const checksum = calculateChecksum(bytes);
      const extractor = EXTRACTORS[textExtractionOf(contentType)];
      if (!extractor) {
        this.logger.debug('Skipping resource with no extractor for its media type', { resourceId, contentType });
        return { kind: 'skipped', checksum, reason: 'no-extractor' };
      }
      const extracted = await extractor.extract(bytes, contentType);
      if ('declined' in extracted) {
        this.logger.debug('Extractor declined', { resourceId, contentType, reason: extracted.declined });
        return { kind: 'skipped', checksum, reason: extracted.declined };
      }
      if (extracted.ocrConfidence && extracted.ocrConfidence.lowConfidenceWords > 0) {
        // Extraction quality, not anchor quality: the vectors and any
        // annotations sit exactly where they belong, but some words under
        // them may be misread. Reported to operators rather than stored —
        // no client can recompute it, and it is a property of the document's
        // text rather than of any one anchor.
        this.logger.info('OCR read words it was unsure of', {
          resourceId,
          contentType,
          ...extracted.ocrConfidence,
        });
      }
      // Publish the coordinate map, keyed by the checksum of the bytes it was
      // derived from (PERSIST-ANCHORS P1b — the producer supplies the key
      // because it alone knows which bytes it read; a byte change racing this
      // publish files the map under the OLD checksum, a harmless orphan the
      // S15 drift class replaces, never wrong geometry under the new one).
      // This is the only process that reads the bytes at ingest, so it is the
      // only one positioned to derive one cheaply — five detection jobs and
      // the browser all arrive later and would each have to redo the decode
      // and the engine. Only extractions that carry geometry produce one:
      // text anchors by character offset, and an empty map on every text
      // resource would be a record that says nothing. Failures are swallowed
      // deliberately — the map is an optimization, the embedding is the job,
      // and a storage problem must not turn a successful index into a skip
      // that hides the resource from search.
      if (extracted.items?.length) {
        try {
          // The whole outcome, provenance included (PERSIST-ANCHORS D1).
          await this.content.putAnchoredText(
            checksum,
            { ...extracted, items: extracted.items },
          );
        } catch (error) {
          this.logger.debug('Could not publish anchored text', {
            resourceId,
            checksum,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (extracted.unreadPages?.length) {
        // Partial coverage: this resource embeds, but semantic search cannot
        // see these pages until they are OCR'd. Logged where it is known, so
        // both the live and batch paths report it exactly once.
        this.logger.info('Partial extraction coverage', {
          resourceId,
          contentType,
          unreadPages: extracted.unreadPages,
        });
      }
      // Provenance for the projection: text recognized from pixels is not the
      // same claim as text read from the document, and no consumer downstream
      // can tell the difference once the chunk travels alone.
      return extracted.text.trim()
        ? { kind: 'text', text: extracted.text, checksum, machineRead: extracted.method === 'ocr' }
        : { kind: 'skipped', checksum, reason: 'empty' };
    } catch (error) {
      this.logger.warn('Content unavailable for embedding', { resourceId, error: errField(error) });
      return { kind: 'unavailable' };
    }
  }

  /**
   * The Smelter's single outbound signal (SMELTER-AXIOMS D3 as amended by
   * SMELTER-INDEX-SYNC): a per-resource decision report for the barrier
   * fold. Best-effort — waiters degrade to their bounded timeout; a signal
   * failure must never fail the embed.
   */
  private async emitSettled(resourceId: string, contentChecksum: string, outcome: 'indexed' | 'skipped', reason?: SkipReason): Promise<void> {
    try {
      await this.bus.emit('smelt:settled', { resourceId, contentChecksum, outcome, ...(reason ? { reason } : {}) });
    } catch (error) {
      this.logger.warn('Failed to emit smelt:settled', { resourceId, outcome, error: errField(error) });
    }
  }

  /**
   * Read a resource's current entity types from the materialized view — the
   * authoritative source, updated before the EventBus fires to consumers — so
   * its vectors carry the discriminator `searchResources` filters on (e.g.
   * exclude `['Question']`). One read on every embed path, mirroring how the
   * smelter already reads current content and annotations; a failed read
   * propagates to the pipeline's per-resource error handler (reconcile heals),
   * rather than silently stamping `[]` and letting the resource leak into recall.
   */
  private async resolveEntityTypes(resourceId: string): Promise<string[]> {
    const { resource } = await busRequest(
      this.bus,
      'browse:resource-requested',
      { resourceId },
    );
    return getResourceEntityTypes(resource);
  }

  private async embedResource(event: SmelterInput, logMessage: string): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;

    const fetched = await this.fetchEmbeddableText(rid);
    if (fetched.kind === 'unavailable') return;
    if (fetched.kind === 'skipped') {
      // A decline is a decision: converge the store too. An eligible
      // resource whose current bytes yield no text must not keep vectors
      // from earlier bytes (S11) — transient failures, by contrast, never
      // reach here and never touch the store (A2).
      await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
      await this.emitSettled(rid, fetched.checksum, 'skipped', fetched.reason);
      return;
    }

    const chunks = chunkText(fetched.text, this.chunkingConfig);
    if (chunks.length === 0) {
      await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
      await this.emitSettled(rid, fetched.checksum, 'skipped', 'empty');
      return;
    }

    const entityTypes = await this.resolveEntityTypes(rid);
    const embeddings = await this.embeddingProvider.embedBatch(chunks);
    const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
      chunkIndex: i, text: t, embedding: embeddings[i],
    }));

    await this.vectorStore.upsertResourceVectors(makeResourceId(rid), embeddingChunks, fetched.checksum, entityTypes, fetched.machineRead);
    await this.emitSettled(rid, fetched.checksum, 'indexed');
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

  /**
   * Restore what `handleResourceArchived` deleted, from CURRENT state: the
   * resource's vectors (media-gated, full-replace) and its current exact-text
   * annotations — the same catalog read `reconcile()` uses, so the live path
   * and a restart agree (bugs/smelter-misses-unarchive.md).
   */
  private async handleResourceUnarchived(event: SmelterInput): Promise<void> {
    const rid = event.resourceId;
    if (!rid) return;

    await this.embedResource(event, 'Re-embedded unarchived resource');

    const { annotations } = await busRequest(
      this.bus,
      'browse:annotations-requested',
      { resourceId: rid },
    );
    for (const annotation of annotations) {
      await this.indexAnnotation(rid, annotation);
    }
  }

  private async handleAnnotationAdded(event: SmelterInput): Promise<void> {
    const annotation = event.payload.annotation as Annotation | undefined;
    if (!annotation?.id) return;

    const rid = event.resourceId;
    if (!rid) return;

    await this.indexAnnotation(rid, annotation);
  }

  private async indexAnnotation(rid: string, annotation: Annotation): Promise<void> {
    if (!annotation.id) return;

    const selector = getTargetSelector(annotation.target);
    const exactText = getExactText(selector);
    if (!exactText?.trim()) return;

    const aid = makeAnnotationId(annotation.id);
    const embedding = await this.embeddingProvider.embed(exactText);

    // An annotation quotes its resource's text, so it inherits that text's
    // provenance — but the annotation record does not carry it, and
    // re-deriving it would mean re-extracting (for a scan, re-running OCR).
    // Read it from the resource's own stamp instead: one targeted lookup,
    // trivial beside the embedding call just made.
    const stamp = await this.vectorStore.getResourceStamp(makeResourceId(rid));

    const payload: AnnotationPayload = {
      annotationId: aid,
      resourceId: makeResourceId(rid),
      motivation: annotation.motivation ?? '',
      entityTypes: ((annotation as Record<string, unknown>).entityTypes as string[] | undefined) ?? [],
      exactText,
      ...(stamp?.machineRead ? { machineRead: true } : {}),
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
    const resourceData: { rid: ResourceId; chunks: string[]; checksum: string; entityTypes: string[]; machineRead: boolean }[] = [];
    const allChunks: string[] = [];

    for (const event of events) {
      const rid = event.resourceId;
      if (!rid) continue;

      const fetched = await this.fetchEmbeddableText(rid);
      if (fetched.kind === 'unavailable') continue;
      if (fetched.kind === 'skipped') {
        // Decline = decision: converge the store (S11) — see embedResource.
        await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
        await this.emitSettled(rid, fetched.checksum, 'skipped', fetched.reason);
        continue;
      }

      const chunks = chunkText(fetched.text, this.chunkingConfig);
      if (chunks.length === 0) {
        await this.vectorStore.deleteResourceVectors(makeResourceId(rid));
        await this.emitSettled(rid, fetched.checksum, 'skipped', 'empty');
        continue;
      }

      const entityTypes = await this.resolveEntityTypes(rid);
      resourceData.push({ rid: makeResourceId(rid), chunks, checksum: fetched.checksum, entityTypes, machineRead: fetched.machineRead });
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) return events.length;

    const allEmbeddings = await this.embeddingProvider.embedBatch(allChunks);

    let offset = 0;
    for (const { rid, chunks, checksum, entityTypes, machineRead } of resourceData) {
      const embeddingChunks: EmbeddingChunk[] = chunks.map((t, i) => ({
        chunkIndex: i, text: t, embedding: allEmbeddings[offset + i],
      }));
      await this.vectorStore.upsertResourceVectors(rid, embeddingChunks, checksum, entityTypes, machineRead);
      await this.emitSettled(String(rid), checksum, 'indexed');
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
      const [indexedResources, indexedAnnotations, anchoredKeys] = await Promise.all([
        this.vectorStore.listResourceStamps(),
        this.vectorStore.listAnnotationIds(),
        // The artifact store's would-hit keys — one bulk read, never a probe
        // per resource (PERSIST-ANCHORS P0). Keys are resource ids today;
        // P1 rekeys the store by content checksum and this lookup moves
        // with it.
        this.content.listAnchoredTextKeys().then((keys) => new Set(keys)),
      ]);
      const resources = await this.listAllResources();
      this.logger.info('Reconcile started', {
        indexedResources: indexedResources.size,
        indexedAnnotations: indexedAnnotations.size,
        anchoredArtifacts: anchoredKeys.size,
        liveResources: resources.length,
      });

      const embeddable = this.classifyEmbeddable(resources);

      const work: SmelterWorkItem[] = [];

      for (const rid of indexedResources.keys()) {
        if (!embeddable.has(rid)) work.push({ type: 'smelt:purge', resourceId: rid, payload: {} });
      }
      for (const [rid, catalog] of embeddable) {
        const indexed = indexedResources.get(rid);
        if (!indexed) {
          work.push({ type: 'smelt:embed', resourceId: rid, payload: {} });
        } else if (catalog.checksum !== undefined && indexed.contentChecksum !== catalog.checksum) {
          // Stale-but-present content: indexed from earlier bytes (or from a
          // pre-stamp deployment, where the stamp reads as undefined) —
          // re-embed (S12). The fresh embed re-reads the tags too.
          work.push({ type: 'smelt:embed', resourceId: rid, payload: {} });
        } else if (!sameStringSet(indexed.entityTypes, catalog.entityTypes)) {
          // Content current, tags drifted: tag edits change no bytes, so the
          // checksum diff is blind to them — payload-only restamp (S13),
          // never an embedding call.
          work.push({ type: 'smelt:restamp', resourceId: rid, payload: {} });
        }
        // Third drift class (PERSIST-ANCHORS P0), deliberately NOT in the
        // else-if chain: tag drift and a lost artifact can co-occur, and
        // each work item heals its own half. Indexed at the current checksum
        // means embed/re-embed will not run (those paths re-publish the
        // artifact as a side effect); a geometry-capable extractor means an
        // artifact SHOULD exist; an absent key means it was lost — the store
        // is container-transient today, and a publish can fail silently.
        // A catalog without a checksum cannot claim "current", so it never
        // plans re-anchoring — the stamp diff owns that resource's fate.
        // The store is checksum-keyed (P1b), so presence is asked by the
        // catalog's checksum — the identity of the bytes — not the rid.
        if (indexed && catalog.checksum !== undefined
            && indexed.contentChecksum === catalog.checksum
            && catalog.yieldsGeometry && !anchoredKeys.has(catalog.checksum)) {
          work.push({ type: 'smelt:reanchor', resourceId: rid, payload: {} });
        }
      }

      // Annotations: every live resource is consulted — not just the
      // re-embedded ones — so orphan detection sees the full live set.
      const liveAnnotationIds = new Set<string>();
      for (const resource of resources) {
        const rid = resource['@id'];
        if (!rid) continue;
        const { annotations } = await busRequest(
          this.bus,
          'browse:annotations-requested',
          { resourceId: rid },
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
        resourcesRestamped: work.filter((w) => w.type === 'smelt:restamp').length,
        resourcesReanchored: work.filter((w) => w.type === 'smelt:reanchor').length,
        resourceVectorsDeleted: work.filter((w) => w.type === 'smelt:purge').length,
        annotationsEmbedded: work.filter((w) => w.type === 'smelt:embed-annotation').length,
        annotationVectorsDeleted: work.filter((w) => w.type === 'smelt:purge-annotation').length,
        resourcesEligible: embeddable.size,
        resourcesIndexed: (await this.vectorStore.listResourceStamps()).size,
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
   *
   * Serialized through `drainChain`: there is ONE waiter slot, and the
   * planners that drain (reconcile, `smelt:rebuild-anchors`) must not
   * interleave — a rebuild command arriving mid-reconcile waits its turn.
   *
   * @returns how many of THESE items failed — the rebuild command's
   * partial-failure accounting (failure detail is in the logs).
   */
  private async drain(work: SmelterWorkItem[]): Promise<number> {
    let failures = 0;
    const run = this.drainChain.then(async () => {
      const failedBefore = this.workFailed;
      for (let i = 0; i < work.length; i += Smelter.RECONCILE_WAVE) {
        const wave = work.slice(i, i + Smelter.RECONCILE_WAVE);
        const done = new Promise<void>((resolve) => {
          this.workWaiter = { target: this.workDone + wave.length, resolve };
        });
        for (const item of wave) this.eventSubject.next(item);
        await done;
      }
      failures = this.workFailed - failedBefore;
    });
    // Keep the chain alive whatever happens to this drain — a rejected tail
    // would wedge every later planner.
    this.drainChain = run.then(() => undefined, () => undefined);
    await run;
    return failures;
  }

  /**
   * `smelt:rebuild-anchors` — the operator's explicit re-derivation of
   * anchored-text artifacts (PERSIST-ANCHORS P0), shaped after
   * `weave:rebuild`: optionally scoped, strictly serialized (concatMap on
   * the command stream + the drain chain), correlated ok/failed replies,
   * and partial completion FAILS — a rebuild that quietly skipped resources
   * would present exactly like a document with no text, which is the #845
   * failure mode wearing different clothes.
   *
   * Never destructive: nothing is deleted first, stale entries are simply
   * overwritten (the W5-frames lesson — a rebuild that clears before it
   * re-derives turns a partial failure into a loss). Re-anchoring makes
   * zero embedding calls; work items ride the normal per-resource lanes,
   * so a rebuild can never interleave with live processing of the same
   * resource (S1/S2).
   */
  private async rebuildAnchors(command: EventMap['smelt:rebuild-anchors']): Promise<void> {
    const { correlationId, resourceId } = command;
    try {
      let work: SmelterWorkItem[];
      if (resourceId) {
        work = [{ type: 'smelt:reanchor', resourceId, payload: {} }];
      } else {
        const resources = await this.listAllResources();
        work = [...this.classifyEmbeddable(resources)]
          .filter(([, catalog]) => catalog.yieldsGeometry)
          .map(([rid]) => ({ type: 'smelt:reanchor' as const, resourceId: rid, payload: {} }));
      }
      this.logger.info('Anchored-text rebuild started', { scoped: resourceId ?? null, resources: work.length });
      const failed = await this.drain(work);
      if (failed > 0) {
        await this.bus.emit('smelt:rebuild-anchors-failed', {
          ...(correlationId ? { correlationId } : {}),
          message: `${failed} of ${work.length} resources failed to re-anchor — see smelter logs`,
        });
        return;
      }
      await this.bus.emit('smelt:rebuild-anchors-ok', correlationId ? { correlationId } : {});
      this.logger.info('Anchored-text rebuild complete', { scoped: resourceId ?? null, resources: work.length });
    } catch (error) {
      this.logger.error('Anchored-text rebuild failed', { error: errField(error) });
      try {
        await this.bus.emit('smelt:rebuild-anchors-failed', {
          ...(correlationId ? { correlationId } : {}),
          message: error instanceof Error ? error.message : String(error),
        });
      } catch (emitError) {
        this.logger.warn('Failed to emit smelt:rebuild-anchors-failed', { error: errField(emitError) });
      }
    }
  }

  /**
   * Embeddable live resources, each with the catalog's claims: the primary
   * representation's checksum (the bytes the smelter would read), the
   * current entity-type set (the discriminator the stamps must carry), and
   * whether the media type's extractor derives geometry (whether an
   * anchored-text artifact should exist). Embeddable ⇔ an extractor exists
   * for the media type's strategy — the same registry the live fetch
   * resolves, and `yieldsGeometry` is declared on the extractor itself, so
   * every gate here and the live fetch's behavior are twins by construction.
   * Shared by `reconcile()` and the `smelt:rebuild-anchors` planner.
   */
  private classifyEmbeddable(
    resources: ResourceDescriptor[],
  ): Map<string, { checksum: string | undefined; entityTypes: string[]; yieldsGeometry: boolean }> {
    const embeddable = new Map<string, { checksum: string | undefined; entityTypes: string[]; yieldsGeometry: boolean }>();
    for (const resource of resources) {
      const mediaType = getPrimaryMediaType(resource);
      const extractor = mediaType ? EXTRACTORS[textExtractionOf(mediaType)] : null;
      if (resource['@id'] && extractor) {
        embeddable.set(resource['@id'], {
          checksum: getPrimaryRepresentation(resource)?.checksum,
          entityTypes: getResourceEntityTypes(resource),
          yieldsGeometry: extractor.yieldsGeometry,
        });
      }
    }
    return embeddable;
  }

  /** Page through `browse:resources-requested` until the catalog is exhausted. */
  private async listAllResources(): Promise<ResourceDescriptor[]> {
    const all: ResourceDescriptor[] = [];
    for (;;) {
      const page = await busRequest(
        this.bus,
        'browse:resources-requested',
        { archived: false, offset: all.length, limit: Smelter.RECONCILE_PAGE_SIZE },
      );
      all.push(...page.resources);
      if (page.resources.length === 0 || all.length >= page.total) return all;
    }
  }
}
