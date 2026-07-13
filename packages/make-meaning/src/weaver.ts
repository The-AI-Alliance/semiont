/**
 * Weaver
 *
 * Subscribes to resource events and updates GraphDB accordingly.
 * Makes GraphDB a projection of Event Store events (single source of truth).
 *
 * Uses an RxJS pipeline with adaptive burst buffering:
 *   - First event after idle passes through immediately (zero latency)
 *   - Subsequent events in a burst are batched and flushed together
 *   - After idle, returns to passthrough mode
 *
 * Per-resource ordering is preserved via groupBy(resourceId) + concatMap.
 * Cross-resource parallelism is provided via mergeMap over groups.
 *
 * Burst buffer thresholds:
 *   BURST_WINDOW_MS  = 50   — debounce window before flushing a batch
 *   MAX_BATCH_SIZE   = 500  — force flush to bound memory
 *   IDLE_TIMEOUT_MS  = 200  — silence before returning to passthrough
 *
 * ## Per-resource serialization
 *
 * `groupBy(resourceId) + concatMap(...)` is the stream-consumer flavor of
 * per-resource serialization — the same invariant enforced by `Smelter`,
 * `Gatherer`, and (in a different shape) `ViewManager`. See
 * `packages/core/src/serialize-per-key.ts` for the shared primitive used
 * by RPC-style services.
 */

import { Subject, Subscription, from, type Observable } from 'rxjs';
import { groupBy, mergeMap, concatMap } from 'rxjs/operators';
import { didToAgent, burstBuffer, errField, busRequest } from '@semiont/core';
import type { BusRequestPrimitive, EventMap } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import type { PersistedEvent, StoredEvent, EventOfType, ResourceId, Logger} from '@semiont/core';
import type { WeaverCheckpoint } from './weaver-checkpoint.js';
import { resourceId as makeResourceId, annotationId as makeAnnotationId, findBodyItem } from '@semiont/core';
import { partitionByType } from './batch-utils.js';

import type { Annotation, CreateAnnotationInternal } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';

export class Weaver {
  // Burst buffer thresholds — see class doc
  private static readonly BURST_WINDOW_MS = 50;
  private static readonly MAX_BATCH_SIZE = 500;
  private static readonly IDLE_TIMEOUT_MS = 200;

  // Catch-up (WEAVER-ISOLATION P3, D1 = checkpointed replay)
  private static readonly CATCHUP_PAGE_SIZE = 200;
  private static readonly CATCHUP_DRAIN_TIMEOUT_MS = 30_000;
  private static readonly CHECKPOINT_FLUSH_MS = 5_000;

  private sourceSubscription: Subscription | null = null;
  private rebuildSubscription: Subscription | null = null;
  private eventSubject = new Subject<StoredEvent>();
  private pipelineSubscription: Subscription | null = null;
  private lastProcessed: Map<string, number> = new Map();
  private _applyFailures = 0;
  private checkpointDirty = false;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: Logger;

  /**
   * Transport-blind by construction (WEAVER-ISOLATION P2/P3): graph-relevant
   * events arrive as an injected `events$` and rebuild commands as
   * `rebuilds$` (the `WeaverActorStateUnit` fan-in — channel selection
   * lives there); `weave:applied` signals, rebuild replies, and the
   * catch-up's `browse:*` reads all ride the injected `BusRequestPrimitive`.
   * In-process everything rides the core EventBus (`workerBusOverEventBus`
   * / `asBusRequestPrimitive`); standalone it all rides the gateway.
   */
  constructor(
    private graphDb: GraphDatabase,
    private events$: Observable<StoredEvent>,
    private rebuilds$: Observable<EventMap['weave:rebuild']>,
    private bus: BusRequestPrimitive,
    private checkpoint: WeaverCheckpoint,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  async initialize() {
    this.logger.info('Weaver initialized');
    this.buildPipeline();

    // Rebuild commands run strictly one at a time — a full rebuild must
    // never interleave with another rebuild.
    this.rebuildSubscription = this.rebuilds$.pipe(
      concatMap((command) => from(this.handleRebuildCommand(command))),
    ).subscribe({
      error: (err) => this.logger.error('Weaver rebuild stream error', { error: errField(err) }),
    });

    this.checkpointTimer = setInterval(() => {
      void this.flushCheckpoint();
    }, Weaver.CHECKPOINT_FLUSH_MS);
  }

  /**
   * Wire the injected event stream through the RxJS burst-buffered pipeline.
   */
  private buildPipeline() {
    // Build the RxJS pipeline
    this.pipelineSubscription = this.eventSubject.pipe(
      // Split into one inner Observable per resource (system events grouped under '__system__')
      groupBy((se: StoredEvent) => se.resourceId ?? '__system__'),

      mergeMap((group) => {
        if (group.key === '__system__') {
          // System events (e.g., entitytype.added): process immediately, sequentially
          return group.pipe(
            concatMap((se) => from(this.safeApplyEvent(se)))
          );
        }

        // Resource events: apply burst buffering per resource group
        return group.pipe(
          burstBuffer<StoredEvent>({
            burstWindowMs: Weaver.BURST_WINDOW_MS,
            maxBatchSize: Weaver.MAX_BATCH_SIZE,
            idleTimeoutMs: Weaver.IDLE_TIMEOUT_MS,
          }),
          concatMap((eventOrBatch: StoredEvent | StoredEvent[]) => {
            if (Array.isArray(eventOrBatch)) {
              return from(this.processBatch(eventOrBatch));
            }
            return from(this.safeApplyEvent(eventOrBatch).then((applied) => {
              if (applied) {
                this.noteApplied(
                  eventOrBatch.resourceId!,
                  eventOrBatch.metadata.sequenceNumber
                );
              }
            }));
          })
        );
      })
    ).subscribe({
      error: (err) => {
        this.logger.error('Weaver pipeline error', { error: err });
      }
    });

    // Subscribe the injected source last so nothing races the pipeline.
    this.sourceSubscription = this.events$.subscribe(
      (storedEvent: StoredEvent) => this.eventSubject.next(storedEvent)
    );

    this.logger.info('Subscribed to graph-relevant events with burst-buffered pipeline');
  }

  /**
   * Record an applied event's sequence and signal `weave:applied` — the
   * push half of the applied-offset barrier (GRAPH-PROJECTION-SYNC P2):
   * `WeaveProgress` folds these signals into the map `whenApplied` awaits.
   */
  private noteApplied(resourceId: string, sequenceNumber: number): void {
    this.lastProcessed.set(resourceId, sequenceNumber);
    this.checkpointDirty = true;
    // Fire-and-forget signal: in-process the shim's emit is synchronous;
    // over HTTP a lost signal only means a barrier timeout (the poll floor
    // absorbs it), so a warn is the right ceiling.
    this.bus.emit('weave:applied', { resourceId, sequenceNumber }).catch((err) => {
      this.logger.warn('weave:applied emit failed', { resourceId, sequenceNumber, error: errField(err) });
    });
  }

  private async flushCheckpoint(): Promise<void> {
    if (!this.checkpointDirty) return;
    this.checkpointDirty = false;
    try {
      await this.checkpoint.save(Object.fromEntries(this.lastProcessed));
    } catch (error) {
      this.checkpointDirty = true;
      this.logger.warn('Weaver checkpoint flush failed', { error: errField(error) });
    }
  }

  /**
   * Checkpointed catch-up (WEAVER-ISOLATION P3, D1). Rides EXISTING read
   * channels: resources discovered via `browse:resources-requested`
   * (archived included — no filter), each resource's events fetched via
   * `browse:events-requested` (full StoredEvents), filtered client-side
   * against the persisted checkpoint, and pushed through the normal
   * pipeline — per-resource lanes serialize against live traffic,
   * idempotent folds (P1) absorb any overlap, and `noteApplied` fires per
   * apply so the `whenApplied` barrier keeps working mid-recovery.
   *
   * A checkpoint AHEAD of a resource's log (restore rewound history) is
   * answered with a per-resource rebuild instead of trusting the
   * checkpoint. Call after the live subscription is attached so nothing
   * falls in the gap.
   */
  /**
   * The Weaver's only view of history: reads over the bus. It has no event
   * store attachment — in-process and standalone alike, catch-up and
   * rebuild ride `browse:resources-requested` / `browse:events-requested`.
   */
  private async fetchAllResources(): Promise<ResourceDescriptor[]> {
    const resources: ResourceDescriptor[] = [];
    for (;;) {
      const page = await busRequest(this.bus, 'browse:resources-requested', {
        offset: resources.length,
        limit: Weaver.CATCHUP_PAGE_SIZE,
      });
      resources.push(...(page.resources as ResourceDescriptor[]));
      if (page.resources.length === 0 || resources.length >= page.total) break;
    }
    return resources;
  }

  /** A resource's full event history over the bus, sorted by sequence. */
  private async fetchResourceEvents(resourceId: string): Promise<StoredEvent[]> {
    const reply = await busRequest(this.bus, 'browse:events-requested', { resourceId });
    return [...(reply.events as StoredEvent[])]
      .sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);
  }

  async catchUp(): Promise<{
    resourcesChecked: number;
    eventsReplayed: number;
    resourcesRebuilt: number;
    eventsFailed: number;
    parityPending: number;
  }> {
    // Failure accounting is a window over the shared counter — concurrent
    // live-apply failures land in the same number, which is the honest
    // reading: they too are events the checkpoint refused to pass.
    const failuresBefore = this._applyFailures;
    const persisted = await this.checkpoint.load();
    for (const [rid, seq] of Object.entries(persisted)) {
      const current = this.lastProcessed.get(rid);
      if (current === undefined || current < seq) this.lastProcessed.set(rid, seq);
    }

    const resources = await this.fetchAllResources();

    let eventsReplayed = 0;
    let resourcesRebuilt = 0;
    const parityTargets = new Map<string, number>();

    for (const resource of resources) {
      const rid = resource['@id'];
      if (!rid) continue;

      const events = await this.fetchResourceEvents(String(rid));
      if (events.length === 0) continue;

      const maxSeq = events[events.length - 1].metadata.sequenceNumber;
      const since = this.lastProcessed.get(String(rid)) ?? 0;

      if (since > maxSeq) {
        // The log is BEHIND the checkpoint — history was rewound (restore).
        // The checkpoint lies for this resource; rebuild it from the log.
        this.logger.warn('Checkpoint ahead of event log — rebuilding resource', {
          resourceId: String(rid), checkpoint: since, logMax: maxSeq,
        });
        this.lastProcessed.delete(String(rid));
        await this.rebuildResource(makeResourceId(String(rid)));
        resourcesRebuilt++;
        continue;
      }

      const gap = events.filter((e) => e.metadata.sequenceNumber > since);
      if (gap.length === 0) continue;
      for (const event of gap) this.eventSubject.next(event);
      eventsReplayed += gap.length;
      parityTargets.set(String(rid), maxSeq);
    }

    const parityPending = await this.awaitParity(parityTargets, Weaver.CATCHUP_DRAIN_TIMEOUT_MS);
    this.checkpointDirty = true;
    await this.flushCheckpoint();

    const summary = {
      resourcesChecked: resources.length,
      eventsReplayed,
      resourcesRebuilt,
      eventsFailed: this._applyFailures - failuresBefore,
      parityPending,
    };
    if (summary.eventsFailed > 0 || summary.parityPending > 0) {
      this.logger.error('Weaver catch-up incomplete — events failed to apply', summary);
    } else {
      this.logger.info('Weaver catch-up complete', summary);
    }
    return summary;
  }

  /**
   * Wait until `lastProcessed` reaches every target sequence — the drain
   * for catch-up's pushes through the async pipeline. Returns the number
   * of targets still unreached at exit. Failed applies hold their sequence
   * back BY DESIGN (#845), so parity may never arrive for them — once the
   * pending set stops shrinking for ~1s we stop draining and report,
   * rather than burning the timeout on events that will not land.
   */
  private async awaitParity(targets: Map<string, number>, timeoutMs: number): Promise<number> {
    if (targets.size === 0) return 0;
    const deadline = Date.now() + timeoutMs;
    let lastPending = -1;
    let stablePolls = 0;
    for (;;) {
      let pending = 0;
      for (const [rid, seq] of targets) {
        if ((this.lastProcessed.get(rid) ?? -1) < seq) pending++;
      }
      if (pending === 0) return 0;
      stablePolls = pending === lastPending ? stablePolls + 1 : 0;
      lastPending = pending;
      if (stablePolls >= 40) {
        this.logger.warn('Weaver catch-up drain stalled — reporting pending parity', { pending });
        return pending;
      }
      if (Date.now() >= deadline) {
        this.logger.warn('Weaver catch-up drain timed out; live pipeline will finish', { pending });
        return pending;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * State-diff audit of the graph against the catalog (#845) — the backstop
   * for divergence nothing witnessed: out-of-band graph mutations, wiped or
   * rolled-back volumes (post-split the checkpoint and the graph live in
   * SEPARATE failure domains), and historical damage from old fold bugs
   * that no future event will re-touch.
   *
   * Detection uses the VIEW as the cheap authority — descriptor facets plus
   * the annotation-id set, over the same `browse:*` reads everything else
   * rides. Healing replays the LOG (`rebuildResource`), so repairs stay
   * log-truthful even if the view itself were wrong. V1 compares identity
   * and facets, not annotation bodies. Heals bypass the pipeline lanes like
   * all rebuilds — the idempotent folds make a race with live traffic
   * benign. Run after `catchUp()`, mirroring the Smelter's
   * subscribe → catch-up → reconcile startup order.
   */
  async reconcile(): Promise<{ resourcesChecked: number; divergent: number; healed: number; healFailures: number }> {
    const resources = await this.fetchAllResources();
    let divergent = 0;
    let healed = 0;
    let healFailures = 0;

    for (const resource of resources) {
      const rid = resource['@id'];
      if (!rid) continue;

      const reason = await this.divergenceOf(resource);
      if (!reason) continue;

      divergent++;
      this.logger.warn('Reconcile divergence — healing from the log', { resourceId: String(rid), reason });
      const result = await this.rebuildResource(makeResourceId(String(rid)));
      if (result.eventsFailed === 0) healed++;
      else healFailures++;
    }

    const summary = { resourcesChecked: resources.length, divergent, healed, healFailures };
    if (divergent > 0 || healFailures > 0) {
      this.logger.warn('Weaver reconcile found divergence', summary);
    } else {
      this.logger.info('Weaver reconcile complete — projection matches the catalog', summary);
    }
    return summary;
  }

  /** Compare one resource's graph state against its view; null = in sync. */
  private async divergenceOf(resource: ResourceDescriptor): Promise<string | null> {
    const graphDb = this.ensureInitialized();
    const rid = String(resource['@id']);

    const doc = await graphDb.getResource(makeResourceId(rid));
    if (!doc) return 'missing-node';
    if ((doc.archived ?? false) !== (resource.archived ?? false)) return 'archived-mismatch';

    const docTags = [...(doc.entityTypes ?? [])].sort();
    const viewTags = [...(resource.entityTypes ?? [])].sort();
    if (docTags.length !== viewTags.length || docTags.some((tag, i) => tag !== viewTags[i])) {
      return 'entity-types-mismatch';
    }

    const { annotations } = await busRequest(this.bus, 'browse:annotations-requested', { resourceId: rid });
    const graphAnnotations = await graphDb.getResourceAnnotations(makeResourceId(rid));
    const viewIds = new Set((annotations as Annotation[]).map((a) => String(a.id)));
    const graphIds = new Set(graphAnnotations.map((a) => String(a.id)));
    if (viewIds.size !== graphIds.size) return 'annotation-set-mismatch';
    for (const id of viewIds) {
      if (!graphIds.has(id)) return 'annotation-set-mismatch';
    }

    return null;
  }

  private async handleRebuildCommand(command: EventMap['weave:rebuild']): Promise<void> {
    try {
      const result = command.resourceId
        ? await this.rebuildResource(makeResourceId(command.resourceId))
        : await this.rebuildAll();
      await this.flushCheckpoint();
      if (result.eventsFailed > 0) {
        // A rebuild that dropped events must FAIL, not claim success —
        // silent under-materialization is the #845 failure mode.
        await this.bus.emit('weave:rebuild-failed', {
          correlationId: command.correlationId,
          message: `rebuild dropped ${result.eventsFailed} event(s) — the graph is incomplete; see weaver logs`,
        });
        return;
      }
      await this.bus.emit('weave:rebuild-ok', { correlationId: command.correlationId });
    } catch (error) {
      this.logger.error('Weaver rebuild command failed', {
        resourceId: command.resourceId, error: errField(error),
      });
      await this.bus.emit('weave:rebuild-failed', {
        correlationId: command.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply one event; returns true iff it landed cleanly. Failures are
   * logged AND counted, and callers must not advance the applied mark past
   * them — `lastProcessed`/checkpoint never skip an event that did not
   * land (#845); catch-up re-replays from the last clean sequence.
   *
   * (The old pre-split `setTimeout(0)` politeness yield is gone — the
   * Weaver owns its isolate now; there is no HTTP loop to starve.)
   */
  private async safeApplyEvent(storedEvent: StoredEvent): Promise<boolean> {
    try {
      await this.applyEventToGraph(storedEvent);
      return true;
    } catch (error) {
      this._applyFailures++;
      this.logger.error('Failed to apply event to graph', {
        eventType: storedEvent.type,
        resourceId: storedEvent.resourceId,
        error: errField(error),
      });
      return false;
    }
  }

  private ensureInitialized(): GraphDatabase {
    return this.graphDb;
  }

  /**
   * Stop the consumer, flush remaining buffered events, and unsubscribe.
   */
  async stop() {
    this.logger.info('Stopping Weaver');

    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    this.rebuildSubscription?.unsubscribe();
    this.rebuildSubscription = null;

    // Unsubscribe from the injected event source (stops feeding the Subject)
    this.sourceSubscription?.unsubscribe();
    this.sourceSubscription = null;

    // Complete the Subject — this triggers burst buffer flush of remaining events
    this.eventSubject.complete();

    // Unsubscribe from the pipeline
    if (this.pipelineSubscription) {
      this.pipelineSubscription.unsubscribe();
      this.pipelineSubscription = null;
    }

    // Create a fresh Subject for potential re-initialization
    this.eventSubject = new Subject<StoredEvent>();

    await this.flushCheckpoint();

    this.logger.info('Weaver stopped');
  }

  /**
   * Process a batch of events for the same resource.
   * Partitions into consecutive same-type runs for batch optimization.
   */
  private async processBatch(events: StoredEvent[]): Promise<void> {
    const runs = partitionByType(events);

    // A failed run blocks checkpoint advance for the REST of the batch:
    // the applied mark must never skip past events that did not land
    // (#845). Catch-up re-replays from the last clean sequence, and the
    // idempotent folds absorb the runs that did land.
    let blocked = false;
    for (const run of runs) {
      let runFailures = 0;
      try {
        if (run.length === 1) {
          runFailures = (await this.safeApplyEvent(run[0])) ? 0 : 1;
        } else {
          runFailures = await this.applyBatchByType(run);
        }
      } catch (error) {
        runFailures = run.length;
        this._applyFailures += run.length;
        this.logger.error('Failed to process batch run', {
          eventType: run[0].type,
          runSize: run.length,
          error: errField(error),
        });
      }
      if (runFailures > 0) blocked = true;
      if (!blocked) {
        const last = run[run.length - 1];
        if (last.resourceId) {
          this.noteApplied(last.resourceId, last.metadata.sequenceNumber);
        }
      }
    }

    this.logger.debug('Processed batch', {
      resourceId: events[0]?.resourceId,
      batchSize: events.length,
    });
  }

  /**
   * Batch-optimized processing for consecutive events of the same type.
   * Uses batch graph methods where available, falls back to sequential.
   */
  /** Returns the number of events in the run that failed to apply (#845). */
  private async applyBatchByType(events: StoredEvent[]): Promise<number> {
    const graphDb = this.ensureInitialized();
    const type = events[0].type;

    switch (type) {
      case 'yield:created': {
        const resources = events.map(e => this.buildResourceDescriptor(e));
        await graphDb.batchCreateResources(resources);
        this.logger.info('Batch created resources in graph', { count: events.length });
        return 0;
      }
      case 'mark:added': {
        // Same idempotent fold as the single-event path, batched: dedupe the
        // run by annotation id, then skip ids the graph already holds — a
        // replayed burst (at-least-once delivery) must not create doubles.
        const byId = new Map<string, CreateAnnotationInternal>();
        for (const e of events) {
          const event = e as EventOfType<'mark:added'>;
          byId.set(String(event.payload.annotation.id), {
            ...event.payload.annotation,
            creator: didToAgent(event.userId),
          });
        }
        const inputs: CreateAnnotationInternal[] = [];
        for (const [id, input] of byId) {
          if (!(await graphDb.getAnnotation(makeAnnotationId(id)))) inputs.push(input);
        }
        if (inputs.length > 0) {
          await graphDb.createAnnotations(inputs);
        }
        this.logger.info('Batch created annotations in graph', {
          count: inputs.length,
          duplicatesSkipped: events.length - inputs.length,
        });
        return 0;
      }
      default: {
        // For types without batch optimization, fall back to sequential
        let failed = 0;
        for (const event of events) {
          if (!(await this.safeApplyEvent(event))) failed++;
        }
        return failed;
      }
    }
  }

  /**
   * Build a ResourceDescriptor from a resource.created event.
   * Extracted for reuse by both applyEventToGraph and applyBatchByType.
   */
  private buildResourceDescriptor(storedEvent: StoredEvent): ResourceDescriptor {
    const event = storedEvent;
    if (event.type !== 'yield:created') {
      throw new Error('Expected resource.created event');
    }
    if (!event.resourceId) {
      throw new Error('yield:created requires resourceId');
    }

    return {
      '@context': 'https://schema.org/',
      '@id': event.resourceId,
      name: event.payload.name,
      entityTypes: event.payload.entityTypes || [],
      representations: [{
        mediaType: event.payload.format,
        checksum: event.payload.contentChecksum,
        rel: 'original',
      }],
      archived: false,
      dateCreated: new Date().toISOString(),
      wasAttributedTo: didToAgent(event.userId),
      ...(event.payload.storageUri ? { storageUri: event.payload.storageUri } : {}),
    };
  }

  /**
   * Apply a single event to GraphDB.
   */
  protected async applyEventToGraph(storedEvent: StoredEvent): Promise<void> {
    const graphDb = this.ensureInitialized();
    const event = storedEvent;

    this.logger.debug('Applying event to GraphDB', {
      eventType: event.type,
      sequenceNumber: storedEvent.metadata.sequenceNumber
    });

    switch (event.type) {
      case 'yield:created': {
        const resource = this.buildResourceDescriptor(storedEvent);
        this.logger.debug('Creating resource in graph', { resourceUri: resource['@id'] });
        await graphDb.createResource(resource);
        this.logger.info('Resource created in graph', { resourceUri: resource['@id'] });
        break;
      }

      case 'mark:archived':
        if (!event.resourceId) throw new Error('mark:archived requires resourceId');
        await graphDb.updateResource(makeResourceId(event.resourceId), {
          archived: true,
        });
        break;

      case 'mark:unarchived':
        if (!event.resourceId) throw new Error('mark:unarchived requires resourceId');
        await graphDb.updateResource(makeResourceId(event.resourceId), {
          archived: false,
        });
        break;

      case 'mark:added': {
        this.logger.debug('Processing annotation.added event', {
          annotationId: event.payload.annotation.id
        });
        // Idempotent fold: creation-by-id is not upsert on every backend, so
        // a redelivered mark:added (at-least-once delivery) must be refused
        // here — the same guard shape as the entity-tag fold below.
        const annId = makeAnnotationId(event.payload.annotation.id);
        if (await graphDb.getAnnotation(annId)) {
          this.logger.debug('Annotation already in graph — duplicate delivery skipped', {
            annotationId: String(annId)
          });
          break;
        }
        await graphDb.createAnnotation({
          ...event.payload.annotation,
          creator: didToAgent(event.userId),
        });
        this.logger.info('Annotation created in graph', {
          annotationId: event.payload.annotation.id
        });
        break;
      }

      case 'mark:removed':
        await graphDb.deleteAnnotation(makeAnnotationId(event.payload.annotationId));
        break;

      case 'mark:body-updated':
        this.logger.debug('Processing annotation.body.updated event', {
          annotationId: event.payload.annotationId,
          payload: event.payload
        });
        try {
          const annId = makeAnnotationId(event.payload.annotationId);

          const currentAnnotation = await graphDb.getAnnotation(annId);

          if (currentAnnotation) {
            let bodyArray = Array.isArray(currentAnnotation.body)
              ? [...currentAnnotation.body]
              : currentAnnotation.body
              ? [currentAnnotation.body]
              : [];

            for (const op of event.payload.operations) {
              if (op.op === 'add') {
                const exists = findBodyItem(bodyArray, op.item) !== -1;
                if (!exists) {
                  bodyArray.push(op.item);
                }
              } else if (op.op === 'remove') {
                const index = findBodyItem(bodyArray, op.item);
                if (index !== -1) {
                  bodyArray.splice(index, 1);
                }
              } else if (op.op === 'replace') {
                const index = findBodyItem(bodyArray, op.oldItem);
                if (index !== -1) {
                  bodyArray[index] = op.newItem;
                }
              }
            }

            await graphDb.updateAnnotation(annId, {
              body: bodyArray,
            } as Partial<Annotation>);

            this.logger.info('updateAnnotation completed successfully');
          } else {
            this.logger.warn('Annotation not found in graph, skipping update');
          }
        } catch (error) {
          this.logger.error('Error in annotation.body.updated handler', {
            annotationId: event.payload.annotationId,
            error: errField(error),
          });
        }
        break;

      case 'mark:entity-tag-added':
        if (!event.resourceId) throw new Error('mark:entity-tag-added requires resourceId');
        {
          const rid = makeResourceId(event.resourceId);
          const doc = await graphDb.getResource(rid);
          // Idempotent fold, mirroring the view materializer's includes-guard:
          // duplicate -added events (stale caller diff base; historical
          // duplicates on rebuild) must not duplicate the tag — the graph and
          // the view are projections of one history and must agree.
          if (doc && !(doc.entityTypes || []).includes(event.payload.entityType)) {
            await graphDb.updateResource(rid, {
              entityTypes: [...(doc.entityTypes || []), event.payload.entityType],
            });
          }
        }
        break;

      case 'mark:entity-tag-removed':
        if (!event.resourceId) throw new Error('mark:entity-tag-removed requires resourceId');
        {
          const rid = makeResourceId(event.resourceId);
          const doc = await graphDb.getResource(rid);
          if (doc) {
            await graphDb.updateResource(rid, {
              entityTypes: (doc.entityTypes || []).filter(t => t !== event.payload.entityType),
            });
          }
        }
        break;

      case 'frame:entity-type-added':
        await graphDb.addEntityType(event.payload.entityType);
        break;

      default:
        this.logger.warn('Unknown event type', { eventType: (event as PersistedEvent).type });
    }
  }

  /**
   * Rebuild entire resource from events.
   * Bypasses the live pipeline — reads directly from event store.
   */
  async rebuildResource(resourceId: ResourceId): Promise<{ eventsApplied: number; eventsFailed: number }> {
    const graphDb = this.ensureInitialized();
    this.logger.info('Rebuilding resource from events', { resourceId });

    try {
      await graphDb.deleteResource(resourceId);
    } catch (error) {
      this.logger.debug('No existing resource to delete', { resourceId });
    }

    const events = await this.fetchResourceEvents(String(resourceId));

    let eventsFailed = 0;
    for (const storedEvent of events) {
      if (!(await this.safeApplyEvent(storedEvent))) eventsFailed++;
    }

    if (events.length > 0 && eventsFailed === 0) {
      // Advance the applied mark through noteApplied so the checkpoint and
      // the whenApplied barrier both see rebuild progress — but only for a
      // CLEAN rebuild: a mark past dropped events would hide them (#845).
      this.noteApplied(String(resourceId), Math.max(...events.map((e) => e.metadata.sequenceNumber)));
    }
    if (eventsFailed > 0) {
      this.logger.error('Resource rebuild dropped events — graph incomplete for this resource', {
        resourceId, eventsFailed,
      });
    }

    this.logger.info('Resource rebuild complete', { resourceId, eventCount: events.length, eventsFailed });
    return { eventsApplied: events.length - eventsFailed, eventsFailed };
  }

  /**
   * Rebuild entire GraphDB from all events.
   * Uses two-pass approach to ensure all resources exist before creating REFERENCES edges.
   * Bypasses the live pipeline — reads directly from event store.
   */
  async rebuildAll(): Promise<{ resources: number; eventsApplied: number; eventsFailed: number }> {
    const graphDb = this.ensureInitialized();
    this.logger.info('Rebuilding entire GraphDB from events');
    this.logger.info('Using two-pass approach: nodes first, then edges');

    await graphDb.clearDatabase();

    // Resources are archive-only (never deleted), so the catalog's resource
    // set matches the event log's — discovery over the bus is complete.
    const allResourceIds = (await this.fetchAllResources())
      .map((resource) => resource['@id'])
      .filter((rid): rid is NonNullable<typeof rid> => !!rid);

    this.logger.info('Found resources to rebuild', { count: allResourceIds.length });

    // Per-resource completeness ledger (#845): the applied mark advances
    // only for resources whose BOTH passes were clean.
    const ledger = new Map<string, { maxSeq: number; attempted: number; failed: number }>();

    // PASS 1: Create all nodes (resources and annotations)
    this.logger.info('PASS 1: Creating all nodes (resources + annotations)');
    for (const resourceId of allResourceIds) {
      const events = await this.fetchResourceEvents(String(resourceId));
      if (events.length === 0) continue;

      const entry = {
        maxSeq: Math.max(...events.map((e) => e.metadata.sequenceNumber)),
        attempted: 0,
        failed: 0,
      };
      ledger.set(String(resourceId), entry);

      for (const storedEvent of events) {
        if (storedEvent.type === 'mark:body-updated') {
          continue;
        }
        entry.attempted++;
        if (!(await this.safeApplyEvent(storedEvent))) entry.failed++;
      }
    }
    this.logger.info('Pass 1 complete - all nodes created');

    // PASS 2: Create all edges (REFERENCES relationships)
    this.logger.info('PASS 2: Creating all REFERENCES edges');
    for (const resourceId of allResourceIds) {
      const events = await this.fetchResourceEvents(String(resourceId));

      for (const storedEvent of events) {
        if (storedEvent.type === 'mark:body-updated') {
          const entry = ledger.get(String(resourceId));
          if (entry) entry.attempted++;
          if (!(await this.safeApplyEvent(storedEvent))) {
            if (entry) entry.failed++;
          }
        }
      }
    }
    this.logger.info('Pass 2 complete - all edges created');

    let eventsApplied = 0;
    let eventsFailed = 0;
    for (const [rid, { maxSeq, attempted, failed }] of ledger) {
      eventsApplied += attempted - failed;
      eventsFailed += failed;
      if (failed === 0) {
        this.noteApplied(rid, maxSeq);
      }
    }
    if (eventsFailed > 0) {
      this.logger.error('Rebuild dropped events — graph incomplete', { eventsFailed });
    }

    this.logger.info('Rebuild complete', { resources: allResourceIds.length, eventsApplied, eventsFailed });
    return { resources: allResourceIds.length, eventsApplied, eventsFailed };
  }

  /**
   * Get consumer health metrics.
   */
  /** Highest applied sequence for a resource, if any — diagnostics/tests. */
  appliedUpTo(resourceId: string): number | undefined {
    return this.lastProcessed.get(resourceId);
  }

  getHealthMetrics(): {
    subscriptions: number;
    resourcesTracked: number;
    pipelineActive: boolean;
    applyFailures: number;
  } {
    return {
      // One injected source stream since WEAVER-ISOLATION P2 — channel
      // fan-in (9 channels) lives in WeaverActorStateUnit.
      subscriptions: this.sourceSubscription ? 1 : 0,
      // A count, deliberately not the map: serializing every per-resource
      // sequence made /health an O(resources) payload (#845 scalability).
      // Per-resource marks are `appliedUpTo()`.
      resourcesTracked: this.lastProcessed.size,
      pipelineActive: !!this.pipelineSubscription,
      // Running count of applies that failed and were therefore NOT
      // checkpointed (#845) — nonzero means the graph is missing events
      // the live pipeline witnessed failing.
      applyFailures: this._applyFailures,
    };
  }

  /**
   * Shutdown consumer.
   */
  async shutdown(): Promise<void> {
    await this.stop();
    this.logger.info('Weaver shut down');
  }
}
