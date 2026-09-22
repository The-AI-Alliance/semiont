/**
 * Stower Actor
 *
 * The single write gateway to the Knowledge Base. Subscribes to command
 * events on the EventBus and translates them into domain events on the
 * EventStore + content operations on the WorkingTreeStore.
 *
 * From ARCHITECTURE.md:
 * The Knowledge Base has exactly three actor interfaces:
 * - Stower (write) — this actor
 * - Gatherer (read context)
 * - Matcher (read search)
 *
 * No other code should call eventStore.appendEvent() or mutate the working tree
 * through kb.content.
 *
 * Subscriptions:
 * - yield:create       → resource.created (+ content store)   → yield:created / yield:create-failed
 * - yield:clone-persist → resource.cloned (+ content store)   → yield:cloned / yield:clone-persist-failed
 * - yield:update       → resource.updated (+ content store)   → yield:updated / yield:update-failed
 * - yield:mv           → resource.moved (+ working tree move) → yield:moved / yield:move-failed
 * - mark:create        → annotation.added                     → mark:created / mark:create-failed
 * - mark:delete        → annotation.removed                   → mark:deleted / mark:delete-failed
 * - mark:update-body   → annotation.body.updated              → (no result event yet)
 * - mark:archive       → resource.archived (+ file removal)   (resource-scoped, no result event)
 * - mark:unarchive     → resource.unarchived                  (resource-scoped, no result event)
 * - frame:add-entity-type → entitytype.added                   → frame:entity-type-added / frame:entity-type-add-failed
 * - frame:add-tag-schema  → tagschema.added                    → frame:tag-schema-added / frame:tag-schema-add-failed
 * - mark:update-entity-types → entitytag.added / entitytag.removed
 * - job:start          → job.started
 * - job:complete       → job.completed
 * - job:fail           → job.failed
 *
 * Note: `job:report-progress` is intentionally NOT persisted. Progress
 * events are ephemeral UI feedback and would clutter the event log
 * (historical logs show ~3× as many progress entries as start+complete
 * combined). UI consumers subscribe to the bus directly for live
 * progress; the event log keeps only the durable lifecycle boundaries.
 */

import { promises as fs } from 'fs';
import { Subscription, from, merge } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import type { Annotation, EventMap, Logger, ResourceDescriptor } from '@semiont/core';
import { EventBus, annotationId, errField, resourceId, userId as makeUserId, generateUuid, hasWorkerRole, attribution } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import { withActorSpan } from '@semiont/observability';
import { resolveStorageUri } from '@semiont/event-sourcing';
import type { SemiontProject } from '@semiont/core/node';
import type { ContentLifecycle, EventAppends } from './knowledge-base';
import { readEntityTypesProjection } from './views/entity-types-reader';
import { validateEntityTypes, entityTypesNotRegisteredMessage } from './views/projection-validators';

export interface CreateResourceResult {
  resourceId: ResourceId;
  resource: ResourceDescriptor;
}

/**
 * The stores Stower writes through (EXTRACT-ARCHIVIST P1): the record's
 * single write seam plus the content lifecycle — never bytes (GATEWAY.md
 * D4a). Resource resolution for moves goes through `project.projectionsDir`.
 */
export interface StowerStores {
  content: ContentLifecycle;
  eventStore: EventAppends;
}

/**
 * The command channels Stower subscribes to — the Archivist's inbound wire
 * roster for this actor (EXTRACT-ARCHIVIST P2a). Pinned to `initialize()`'s
 * actual subscriptions by the census gate in archivist-decoupling.test.ts:
 * grow one, and the gate fails until the other moves with it.
 */
export const STOWER_CHANNELS = [
  'yield:create', 'yield:clone-persist', 'yield:update', 'yield:mv',
  'mark:create', 'mark:commit', 'mark:delete', 'mark:update-body',
  'frame:add-entity-type', 'frame:add-tag-schema',
  'mark:archive', 'mark:unarchive', 'mark:update-entity-types',
  'job:start', 'job:assign', 'job:complete', 'job:fail',
] as const satisfies readonly (keyof EventMap)[];

export class Stower {
  private subscription: Subscription | null = null;
  private readonly logger: Logger;

  constructor(
    private stores: StowerStores,
    private eventBus: EventBus,
    private project: SemiontProject,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Stower actor initialized');

    // `frames`, not `on`: a handler that answers a request must echo the key it
    // was HANDED. The payload stopped carrying one (BUS-CARRIES-FRAMES P3), so
    // the envelope is where a responder reads it and where the reply puts it
    // back.
    const pipe = <K extends keyof EventMap>(
      event: K,
      handler: (e: EventMap[K], correlationId: string | undefined) => Promise<void>,
    ) =>
      this.eventBus.frames(event).pipe(
        concatMap((frame) =>
          from(
            withActorSpan('stower', event as string, () =>
              handler(frame.payload, frame.correlationId),
            ),
          ),
        ),
      );

    this.subscription = merge(
      pipe('yield:create', (e, cid) => this.handleYieldCreate(e, cid)),
      pipe('yield:clone-persist', (e, cid) => this.handleYieldClonePersist(e, cid)),
      pipe('yield:update', (e, cid) => this.handleYieldUpdate(e, cid)),
      pipe('yield:mv', (e) => this.handleYieldMv(e)),
      pipe('mark:create', (e, cid) => this.handleMarkCreate(e, cid)),
      pipe('mark:commit', (e, cid) => this.handleMarkCommit(e, cid)),
      pipe('mark:delete', (e, cid) => this.handleMarkDelete(e, cid)),
      pipe('mark:update-body', (e, cid) => this.handleMarkUpdateBody(e, cid)),
      pipe('frame:add-entity-type', (e, cid) => this.handleAddEntityType(e, cid)),
      pipe('frame:add-tag-schema', (e, cid) => this.handleAddTagSchema(e, cid)),
      pipe('mark:archive', (e, cid) => this.handleMarkArchive(e, cid)),
      pipe('mark:unarchive', (e, cid) => this.handleMarkUnarchive(e, cid)),
      pipe('mark:update-entity-types', (e, cid) => this.handleUpdateEntityTypes(e, cid)),
      pipe('job:start', (e) => this.handleJobStart(e)),
      pipe('job:assign', (e) => this.handleJobAssign(e)),
      pipe('job:complete', (e) => this.handleJobComplete(e)),
      pipe('job:fail', (e) => this.handleJobFail(e)),
    ).subscribe({
      error: (err: unknown) => this.logger.error('Stower pipeline error', { error: err }),
    });
  }

  // ========================================================================
  // Event handlers
  // ========================================================================

  private async handleYieldCreate(event: EventMap['yield:create'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('yield:create missing _userId (gateway injection)');
    }
    const uid = makeUserId(event._userId);
    try {
      // Same rule as mark:commit: a worker-role emitter cites the job, or the
      // create is refused rather than attributed to the model alone.
      if (hasWorkerRole({ roles: event._roles }) && !event.jobId) {
        throw new Error('yield:create refused: a worker-role emitter must cite the job it fulfils in `jobId`');
      }
      // Who asked. A generation's job events sit on the resource it generates
      // FROM, so a cited job is checked against the SOURCE's log — which the
      // command names in generatedFrom.resourceId. A person's own upload is
      // its own requester.
      let requester: string;
      if (event.jobId) {
        const sourceRid = event.generatedFrom?.resourceId;
        if (!sourceRid) {
          throw new Error('yield:create refused: a create citing a job must name the source resource its job was assigned on (generatedFrom.resourceId)');
        }
        requester = await this.requesterOf(resourceId(sourceRid), event.jobId, event._userId);
      } else {
        requester = event._userId;
      }
      if (Array.isArray(event.generator)) {
        throw new Error('yield:create refused: a multi-agent generator is not supported; derivation binds one generator to the executor');
      }
      const derived = attribution({ requester, executor: event._userId, generator: event.generator });
      const rId = resourceId(generateUuid());

      // Content is already on disk at storageUri (callers write before emitting).
      // Register verifies the file exists and validates the checksum.
      const stored = await this.stores.content.register(event.storageUri, event.contentChecksum, { noGit: event.noGit });
      const checksum = stored.checksum;
      const byteSize = event.byteSize;

      // generatedFrom on the bus command has optional fields; the domain event requires both
      const generatedFrom = event.generatedFrom?.resourceId && event.generatedFrom?.annotationId
        ? {
            resourceId: resourceId(event.generatedFrom.resourceId),
            annotationId: annotationId(event.generatedFrom.annotationId),
          }
        : undefined;

      await this.stores.eventStore.appendEvent({
        type: 'yield:created',
        resourceId: rId,
        userId: uid,
        version: 1,
        payload: {
          name: event.name,
          format: event.format,
          contentChecksum: checksum,
          contentByteSize: byteSize,
          storageUri: event.storageUri,
          entityTypes: event.entityTypes || [],
          language: event.language || undefined,
          isDraft: event.isDraft ?? false,
          generatedFrom,
          generationPrompt: event.generationPrompt,
          // Derived, never taken from the emitter (VERIFIED-PROVENANCE P2).
          generator: derived.generator,
          creator: derived.creator,
          wasAttributedTo: derived.wasAttributedTo,
        },
      });

      this.eventBus.emit('yield:create-ok', {
        response: { resourceId: rId },
      }, { correlationId });

      // Auto-bind: when a resource is generated from a reference annotation,
      // resolve the source reference by adding the new resource as a linking
      // body. Emit `mark:update-body`; our own handler appends the
      // `mark:body-updated` event, and the Weaver then updates the
      // annotation body in the graph. Ordering is safe because we've already
      // appended `yield:created` — by the time the Weaver processes
      // `mark:body-updated`, the target resource exists in the graph.
      if (generatedFrom) {
        this.eventBus.emit('mark:update-body', {
          annotationId: generatedFrom.annotationId,
          _userId: event._userId,
          resourceId: generatedFrom.resourceId,
          operations: [
            {
              op: 'add',
              item: {
                type: 'SpecificResource',
                source: rId,
                purpose: 'linking',
              },
            },
          ],
        });
        this.logger.info('Auto-bound generated resource to source reference', {
          resourceId: rId,
          sourceAnnotationId: generatedFrom.annotationId,
          sourceResourceId: generatedFrom.resourceId,
        });
      }
    } catch (error) {
      this.logger.error('Failed to create resource', { error: errField(error) });
      this.eventBus.emit('yield:create-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  /**
   * Persist a clone (the CloneTokenManager's second half).
   *
   * A clone is its own domain fact, not a creation with an extra field: it
   * NAMES the resource it came from, and `ResourceClonedPayload` requires
   * that name. So it gets its own command and appends its own event, rather
   * than an optional parent turning `yield:created` into something else at
   * runtime.
   *
   * The token was already validated and the source's entity types already
   * read by the CloneTokenManager — the one party that can do either. What
   * happens here is what only the Stower may do: register the bytes and
   * append the event (single-writer, GATEWAY.md D4b).
   *
   * Generated resources do NOT come through here. Their provenance is
   * `generatedFrom` on `yield:created`, which is a different relation: a
   * generated resource is derived from a source, a clone IS a copy of one.
   */
  private async handleYieldClonePersist(event: EventMap['yield:clone-persist'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('yield:clone-persist missing _userId (gateway injection)');
    }
    try {
      const rId = resourceId(generateUuid());

      // Same contract as create: the uploader wrote the bytes, register
      // verifies they are there and match the checksum.
      const stored = await this.stores.content.register(event.storageUri, event.contentChecksum, { noGit: event.noGit });

      // A clone is the cloner's own act — never job-fulfilling — so requester
      // and executor are the same party.
      const derived = attribution({ requester: event._userId, executor: event._userId });

      await this.stores.eventStore.appendEvent({
        type: 'yield:cloned',
        resourceId: rId,
        userId: makeUserId(event._userId),
        version: 1,
        payload: {
          name: event.name,
          format: event.format,
          contentChecksum: stored.checksum,
          contentByteSize: event.byteSize,
          storageUri: event.storageUri,
          parentResourceId: event.parentResourceId,
          entityTypes: event.entityTypes || [],
          language: event.language || undefined,
          creator: derived.creator,
          wasAttributedTo: derived.wasAttributedTo,
        },
      });

      this.eventBus.emit('yield:clone-persist-ok', {
        response: { resourceId: rId },
      }, { correlationId });
    } catch (error) {
      this.logger.error('Failed to persist clone', { error: errField(error) });
      this.eventBus.emit('yield:clone-persist-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleYieldUpdate(event: EventMap['yield:update'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('yield:update missing _userId (gateway injection)');
    }
    try {
      // Content is already on disk at storageUri (callers write before emitting).
      // register() verifies the file exists and validates the checksum.
      await this.stores.content.register(event.storageUri, event.contentChecksum, { noGit: event.noGit });
      await this.stores.eventStore.appendEvent({
        type: 'yield:updated',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event._userId),
        version: 1,
        payload: {
          contentChecksum: event.contentChecksum,
          contentByteSize: event.byteSize,
        },
      });
      this.eventBus.emit('yield:update-ok', {
        response: { resourceId: event.resourceId },
      }, { correlationId });
    } catch (error) {
      this.logger.error('Failed to update resource', { error: errField(error) });
      this.eventBus.emit('yield:update-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleYieldMv(event: EventMap['yield:mv']): Promise<void> {
    let rId: ResourceId;
    try {
      const resolved = await resolveStorageUri(this.project.projectionsDir, event.fromUri);
      rId = resolved as ResourceId;
    } catch (error) {
      this.logger.error('Failed to resolve resource for move', { fromUri: event.fromUri, error });
      this.eventBus.emit('yield:move-failed', {
        fromUri: event.fromUri,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!event._userId) {
      throw new Error('yield:mv missing _userId (gateway injection)');
    }
    try {
      await this.stores.content.move(event.fromUri, event.toUri, { noGit: event.noGit });
      await this.stores.eventStore.appendEvent({
        type: 'yield:moved',
        resourceId: rId,
        userId: makeUserId(event._userId),
        version: 1,
        payload: {
          fromUri: event.fromUri,
          toUri: event.toUri,
        },
      });
    } catch (error) {
      this.logger.error('Failed to move resource', { error: errField(error) });
      this.eventBus.emit('yield:move-failed', {
        fromUri: event.fromUri,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMarkCreate(event: EventMap['mark:create'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('mark:create missing _userId (gateway injection)');
    }
    try {
      const annotation = event.annotation as Annotation;
      // The emitter says at most what produced this. Who asked is derived
      // here — for mark:create the emitter itself, since this is the
      // assembled (person's) path and it cites no job. A payload naming a
      // creator is the assertion this design refuses (VERIFIED-PROVENANCE P2).
      if (annotation.creator !== undefined) {
        throw new Error(`mark:create refused: \`creator\` on annotation ${String(annotation.id)} is derived by the knowledge base, never sent`);
      }
      if (Array.isArray(annotation.generator)) {
        throw new Error(`mark:create refused: annotation ${String(annotation.id)} carries a multi-agent generator; derivation binds one generator to the executor`);
      }
      const derived = attribution({ requester: event._userId, executor: event._userId, generator: annotation.generator });
      this.logger.debug('Stowing annotation', { annotationId: annotation.id });
      await this.stores.eventStore.appendEvent(
        {
          type: 'mark:added',
          resourceId: resourceId(event.resourceId),
          userId: makeUserId(event._userId),
          version: 1,
          payload: { annotation: { ...annotation, ...derived } },
        },
        correlationId ? { correlationId } : undefined,
      );
      // annotation-assembly emits mark:create-ok after it observes the
      // persisted mark:added event (keyed by correlationId in metadata).
    } catch (error) {
      this.logger.error('Failed to create annotation', { error: errField(error) });
      this.eventBus.emit('mark:create-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  /**
   * Persist a detection unit's annotations as ONE acknowledged batch, then
   * answer (JOB-RESTART-SAFETY P6).
   *
   * The difference from `mark:create` is the reply, and it is the whole point.
   * `mark:create` is fire-and-forget: the worker's emit resolves when the bus
   * accepts it, which says nothing about the event log, so a down Stower loses
   * a unit silently and a flapping one hangs the worker forever. This answers
   * only after every append has returned, so the worker can gate unit
   * completion — and its checkpoint — on durability.
   *
   * Appends are sequential, not concurrent: the event log is the system of
   * record and a batch that half-lands under concurrency is harder to reason
   * about than one that stops at the first failure.
   *
   * This channel is AT-LEAST-ONCE, and the log must not grow on a repeat
   * (COMMIT-ACK-FALSE-FAILURE F3). Two paths re-send a batch that already
   * landed: an acknowledgement lost after a successful append (the unit is
   * never checkpointed, so the retry re-runs exactly the unit that landed), and
   * a partial batch, reported as a failure and retried whole. Deterministic ids
   * (JOB-RESTART-SAFETY P3) made those safe for the PROJECTIONS — the resource
   * view and the graph both refuse a duplicate id — but a projection's guard
   * says nothing about the log, which appends whatever it is handed. The result
   * was a green graph over a doubled log: silent, and not undoable.
   *
   * So the batch is diffed against what the resource already holds. ONE view
   * read per commit, never per annotation: the view for a 1,673-annotation
   * resource is ~3 MB, and re-reading it per append would cost gigabytes of
   * parsing for a single job.
   */
  private async handleMarkCommit(event: EventMap['mark:commit'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('mark:commit missing _userId (gateway injection)');
    }
    const annotations = (event.annotations ?? []) as Annotation[];
    const rid = resourceId(event.resourceId);
    try {
      // A worker's write cites the job it fulfils, or it is refused. "No job →
      // self-initiated" is true for a person or an autonomous agent; for a
      // worker that forgot the field it would silently attribute the person's
      // request to the model. The gateway stamps `_roles` from the token, so
      // this keys on a capability the emitter cannot forge.
      if (hasWorkerRole({ roles: event._roles }) && !event.jobId) {
        throw new Error('mark:commit refused: a worker-role emitter must cite the job it fulfils in `jobId`');
      }
      // Who asked for this work. From the log when a job is cited — the
      // dispatcher's job:assigned on this resource, checked against the writer
      // — and the writer itself otherwise. Never from the payload.
      const requester = event.jobId
        ? await this.requesterOf(rid, event.jobId, event._userId)
        : event._userId;

      const view = await this.stores.eventStore.viewStorage.get(rid);
      const present = new Set((view?.annotations.annotations ?? []).map((a) => String(a.id)));

      for (const annotation of annotations) {
        if (present.has(String(annotation.id))) continue;
        // The emitter says nothing about identity. `creator` is derived here;
        // a payload carrying one is the assertion this design refuses.
        if (annotation.creator !== undefined) {
          throw new Error(`mark:commit refused: \`creator\` on annotation ${String(annotation.id)} is derived by the knowledge base, never sent`);
        }
        if (Array.isArray(annotation.generator)) {
          throw new Error(`mark:commit refused: annotation ${String(annotation.id)} carries a multi-agent generator; derivation binds one generator to the executor`);
        }
        const derived = attribution({ requester, executor: event._userId, generator: annotation.generator });
        await this.stores.eventStore.appendEvent({
          type: 'mark:added',
          resourceId: rid,
          userId: makeUserId(event._userId),
          version: 1,
          payload: { annotation: { ...annotation, ...derived } },
        });
        // A batch may name the same annotation twice; the view read cannot see
        // an append this loop just made.
        present.add(String(annotation.id));
      }
      this.logger.debug('Committed annotation batch', {
        correlationId, resourceId: event.resourceId, persisted: annotations.length,
      });
      this.eventBus.emit('mark:commit-ok', {
        // The DURABLE count, which is what the acknowledgement means ("every
        // annotation named by the command is in the event log"). Not an append
        // tally: a retry whose annotations are all already present has
        // succeeded, and must be indistinguishable from the first commit or the
        // caller would have to interpret a 0 that means "all good".
        response: { persisted: annotations.length, annotationIds: annotations.map((a) => String(a.id)) },
      }, { correlationId });
    } catch (error) {
      // No partial success is reported. The worker retries the unit whole, and
      // the diff above makes the already-landed fraction a no-op.
      this.logger.error('Failed to commit annotation batch', {
        correlationId, error: errField(error),
      });
      this.eventBus.emit('mark:commit-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleMarkDelete(event: EventMap['mark:delete'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('mark:delete missing _userId (gateway injection)');
    }
    if (!event.resourceId) {
      throw new Error('mark:delete missing resourceId');
    }
    try {
      await this.stores.eventStore.appendEvent({
        type: 'mark:removed',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event._userId),
        version: 1,
        payload: { annotationId: annotationId(event.annotationId) },
      });
      this.eventBus.emit('mark:delete-ok', { response: { annotationId: event.annotationId } }, { correlationId });
    } catch (error) {
      this.logger.error('Failed to delete annotation', { error: errField(error) });
      this.eventBus.emit('mark:delete-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleMarkUpdateBody(event: EventMap['mark:update-body'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('mark:update-body missing _userId (gateway injection)');
    }
    try {
      await this.stores.eventStore.appendEvent(
        {
          type: 'mark:body-updated',
          resourceId: resourceId(event.resourceId),
          userId: makeUserId(event._userId),
          version: 1,
          payload: { annotationId: event.annotationId, operations: event.operations },
        },
        // Thread correlationId from the command into event metadata so the
        // events-stream can deliver it to the client that initiated the bind.
        correlationId ? { correlationId } : undefined,
      );
      // No manual .next() needed — appendEvent publishes StoredEvent on the Core EventBus
    } catch (error) {
      this.logger.error('Failed to update annotation body', { error: errField(error) });
      this.eventBus.emit('mark:body-update-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleMarkArchive(event: EventMap['mark:archive'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('mark:archive missing _userId (gateway injection)');
    }
    try {
      if (event.storageUri) {
        await this.stores.content.remove(event.storageUri, { keepFile: event.keepFile, noGit: event.noGit });
      }
      await this.stores.eventStore.appendEvent({
        type: 'mark:archived',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event._userId),
        version: 1,
        payload: { reason: undefined },
      });
      // Correlation-keyed ack for the SDK's busRequest (the persisted
      // mark:archived domain event remains the system-of-record signal).
      this.eventBus.emit('mark:archive-ok', {}, { correlationId });
    } catch (error) {
      this.logger.error('Failed to archive resource', { error: errField(error) });
      this.eventBus.emit('mark:archive-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleMarkUnarchive(event: EventMap['mark:unarchive'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('mark:unarchive missing _userId (gateway injection)');
    }
    try {
      // If storageUri is provided, verify the file exists before emitting the event.
      if (event.storageUri) {
        const absPath = this.stores.content.resolveUri(event.storageUri);
        try {
          await fs.access(absPath);
        } catch {
          // Was a silent `return` — a missing file now surfaces as a real
          // failure the caller can observe, not a successful-looking no-op.
          throw new Error(`Cannot unarchive: file not found at ${event.storageUri}`);
        }
      }
      await this.stores.eventStore.appendEvent({
        type: 'mark:unarchived',
        resourceId: resourceId(event.resourceId),
        userId: makeUserId(event._userId),
        version: 1,
        payload: {},
      });
      this.eventBus.emit('mark:unarchive-ok', {}, { correlationId });
    } catch (error) {
      this.logger.error('Failed to unarchive resource', { error: errField(error) });
      this.eventBus.emit('mark:unarchive-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleAddEntityType(event: EventMap['frame:add-entity-type'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('frame:add-entity-type missing _userId (gateway injection)');
    }
    try {
      await this.stores.eventStore.appendEvent({
        type: 'frame:entity-type-added',
        userId: makeUserId(event._userId),
        version: 1,
        payload: { entityType: event.tag },
      });
      // appendEvent publishes the `frame:entity-type-added` domain event (the
      // in-process callers' success signal). `*-add-ok` is the correlation-keyed
      // ack the SDK's busRequest awaits (undefined correlationId for in-process
      // emits, which don't await it).
      this.eventBus.emit('frame:entity-type-add-ok', {}, { correlationId });
    } catch (error) {
      this.logger.error('Failed to add entity type', { error: errField(error) });
      this.eventBus.emit('frame:entity-type-add-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleAddTagSchema(event: EventMap['frame:add-tag-schema'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('frame:add-tag-schema missing _userId (gateway injection)');
    }
    try {
      await this.stores.eventStore.appendEvent({
        type: 'frame:tag-schema-added',
        userId: makeUserId(event._userId),
        version: 1,
        payload: { schema: event.schema },
      });
      // See handleAddEntityType: the domain event is the in-process callers'
      // success signal; `*-add-ok` is the correlation-keyed ack for the SDK's busRequest.
      this.eventBus.emit('frame:tag-schema-add-ok', {}, { correlationId });
    } catch (error) {
      this.logger.error('Failed to add tag schema', { schemaId: event.schema?.id, error: errField(error) });
      this.eventBus.emit('frame:tag-schema-add-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleUpdateEntityTypes(event: EventMap['mark:update-entity-types'], correlationId: string | undefined): Promise<void> {
    if (!event._userId) {
      throw new Error('mark:update-entity-types missing _userId (gateway injection)');
    }
    const uid = makeUserId(event._userId);
    const added = event.updatedEntityTypes.filter(et => !event.currentEntityTypes.includes(et));
    const removed = event.currentEntityTypes.filter(et => !event.updatedEntityTypes.includes(et));

    try {
      // Entity tags are a controlled vocabulary (ratified 2026-07-09): gate
      // ADDS against the registered set with the same machinery the job path
      // uses (job-commands.ts) — same projection read, same error message.
      // Removals are never gated: deleting a stale/unregistered legacy tag is
      // the cleanup path. Runs before the first append so a mixed request is
      // all-or-nothing.
      if (added.length > 0) {
        const registered = await readEntityTypesProjection(this.project);
        const result = validateEntityTypes(registered, added);
        if (!result.ok) {
          throw new Error(entityTypesNotRegisteredMessage(result.unknown));
        }
      }

      for (const entityType of added) {
        await this.stores.eventStore.appendEvent({
          type: 'mark:entity-tag-added',
          resourceId: resourceId(event.resourceId),
          userId: uid,
          version: 1,
          payload: { entityType },
        });
      }

      for (const entityType of removed) {
        await this.stores.eventStore.appendEvent({
          type: 'mark:entity-tag-removed',
          resourceId: resourceId(event.resourceId),
          userId: uid,
          version: 1,
          payload: { entityType },
        });
      }

      // Correlation-keyed ack for the SDK's busRequest (the persisted
      // mark:entity-tag-* domain events remain the system-of-record signal).
      this.eventBus.emit('mark:update-entity-types-ok', {}, { correlationId });
    } catch (error) {
      this.logger.error('Failed to update entity types', { error: errField(error) });
      this.eventBus.emit('mark:update-entity-types-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleJobStart(event: EventMap['job:start']): Promise<void> {
    if (!event._userId) {
      throw new Error('job:start missing _userId (gateway injection)');
    }
    await this.stores.eventStore.appendEvent({
      type: 'job:started',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event._userId),
      version: 1,
      payload: {
        jobId: event.jobId,
        jobType: event.jobType,
        ...(event.annotationId ? { annotationId: event.annotationId } : {}),
      },
    });
  }

  /**
   * The dispatcher's record that it accepted a claim: which holder took which
   * job, and who requested it. Persisted under the dispatcher's own identity
   * (`_userId` is the dispatcher's service DID) beside the worker's
   * `job:started`, so a later write citing this job can be checked against the
   * holder and its `creator` derived from the requester by reading this
   * resource's log alone — nothing outside the record, and nothing the writer
   * asserted (VERIFIED-PROVENANCE D1).
   */
  private async handleJobAssign(event: EventMap['job:assign']): Promise<void> {
    if (!event._userId) {
      throw new Error('job:assign missing _userId (gateway injection)');
    }
    await this.stores.eventStore.appendEvent({
      type: 'job:assigned',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event._userId),
      version: 1,
      payload: {
        jobId: event.jobId,
        jobType: event.jobType,
        resourceId: event.resourceId,
        holder: event.holder,
        requester: event.requester,
      },
    });
  }

  /**
   * The requester of a cited job, from this resource's own log — and the
   * check that the writer is the job's recorded holder. A citation the log
   * cannot back, or one made by someone other than the holder, is refused:
   * this is what makes an external worker's writes trustworthy-as-identity
   * without trusting the worker (VERIFIED-PROVENANCE row 6).
   */
  private async requesterOf(rid: ResourceId, jobId: string, writer: string): Promise<string> {
    const events = await this.stores.eventStore.log.getEvents(rid);
    const assigned = events.find((e) => e.type === 'job:assigned' && e.payload.jobId === jobId);
    if (!assigned || assigned.type !== 'job:assigned') {
      throw new Error(`refused: cites job ${jobId}, but this resource's log holds no assignment for it`);
    }
    if (assigned.payload.holder !== writer) {
      throw new Error(`refused: job ${jobId}'s recorded holder is ${assigned.payload.holder}, not the writer ${writer}`);
    }
    return assigned.payload.requester;
  }

  private async handleJobComplete(event: EventMap['job:complete']): Promise<void> {
    if (!event._userId) {
      throw new Error('job:complete missing _userId (gateway injection)');
    }
    await this.stores.eventStore.appendEvent({
      type: 'job:completed',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event._userId),
      version: 1,
      payload: {
        jobId: event.jobId,
        jobType: event.jobType,
        ...(event.annotationId ? { annotationId: event.annotationId } : {}),
        result: event.result,
        // Which attempt produced this. Always present on the wire, so always
        // persisted: the log is where a campaign's spend is reconstructed, and
        // without it the record cannot say a document ran twice.
        ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
        // How durability was ESTABLISHED (COMMIT-ACK-FALSE-FAILURE). An
        // acknowledged batch and one inferred from a probe are different
        // claims; absent means the question never arose.
        ...(event.durability !== undefined ? { durability: event.durability } : {}),
      },
    });
  }

  private async handleJobFail(event: EventMap['job:fail']): Promise<void> {
    if (!event._userId) {
      throw new Error('job:fail missing _userId (gateway injection)');
    }
    await this.stores.eventStore.appendEvent({
      type: 'job:failed',
      resourceId: resourceId(event.resourceId),
      userId: makeUserId(event._userId),
      version: 1,
      payload: {
        jobId: event.jobId,
        jobType: event.jobType,
        ...(event.annotationId ? { annotationId: event.annotationId } : {}),
        error: event.error,
        // Which attempt produced this. Always present on the wire, so always
        // persisted: the log is where a campaign's spend is reconstructed, and
        // without it the record cannot say a document ran twice.
        ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
        // The worker's JUDGMENTS, not just its message. Both are computed where
        // the error is still typed and are unrecoverable here — the only other
        // witness in the log is `error`, a flattened English string. Spread
        // conditionally: absent `failureClass` means UNRECOGNISED, a different
        // claim from 'transient', and defaulting either would write a judgment
        // nobody made into a log nobody can rewrite.
        ...(event.failureClass !== undefined ? { failureClass: event.failureClass } : {}),
        ...(event.willRetry !== undefined ? { willRetry: event.willRetry } : {}),
        // How durability was ESTABLISHED (COMMIT-ACK-FALSE-FAILURE). An
        // acknowledged batch and one inferred from a probe are different
        // claims; absent means the question never arose.
        ...(event.durability !== undefined ? { durability: event.durability } : {}),
      },
    });
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.logger.info('Stower actor stopped');
  }
}
