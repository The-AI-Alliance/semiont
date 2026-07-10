/**
 * Event Replay
 *
 * Replays parsed JSONL event streams through the EventBus.
 * Each domain event is translated to the corresponding command event
 * (e.g. yield:created → yield:create), emitted, and the result
 * event is awaited before proceeding (backpressure).
 *
 * Content blobs are resolved lazily via a lookup function so that
 * the caller controls memory strategy (streaming, on-disk, etc.).
 */

import { awaitReply } from './await-reply';
import type { Logger, StoredEvent, PersistedEvent, ResourceId, AnnotationId } from '@semiont/core';
import { EventBus, baseMediaType, isSupportedMediaType, busRequest } from '@semiont/core';
import { asBusRequestPrimitive } from '../bus-request-local';
import type { components } from '@semiont/core';
import type { WorkingTreeStore } from '@semiont/content';
import { deriveStorageUri } from '@semiont/content';
import type { EventStore } from '@semiont/event-sourcing';

type ContentFormat = components['schemas']['ContentFormat'];
import type { Annotation } from '@semiont/core';

/**
 * Resolves a content blob by its checksum.
 * Returned by the caller so replay doesn't dictate memory strategy.
 */
export type ContentBlobResolver = (checksum: string) => Buffer | undefined;

export interface ReplayStats {
  eventsReplayed: number;
  resourcesCreated: number;
  annotationsCreated: number;
  entityTypesAdded: number;
}

export interface ReplayResult {
  stats: ReplayStats;
}

const REPLAY_TIMEOUT_MS = 30_000;

/**
 * Replay a JSONL event stream through the EventBus.
 *
 * Events are emitted sequentially — each command event waits for
 * its result before the next is emitted. This matches the Stower's
 * concatMap processing guarantee.
 */
export async function replayEventStream(
  jsonl: string,
  eventBus: EventBus,
  eventStore: EventStore,
  resolveBlob: ContentBlobResolver,
  contentStore: WorkingTreeStore,
  logger?: Logger,
): Promise<ReplayResult> {
  const lines = jsonl.trim().split('\n').filter((l) => l.length > 0);
  const storedEvents: StoredEvent[] = lines.map((line) => JSON.parse(line));

  const stats: ReplayStats = {
    eventsReplayed: 0,
    resourcesCreated: 0,
    annotationsCreated: 0,
    entityTypesAdded: 0,
  };

  // Replay each event
  for (const stored of storedEvents) {
    await replayEvent(stored, eventBus, eventStore, resolveBlob, contentStore, stats, logger);
    stats.eventsReplayed++;
  }

  return { stats };
}

async function replayEvent(
  event: PersistedEvent,
  eventBus: EventBus,
  eventStore: EventStore,
  resolveBlob: ContentBlobResolver,
  contentStore: WorkingTreeStore,
  stats: ReplayStats,
  logger?: Logger,
): Promise<void> {
  switch (event.type) {
    case 'frame:entity-type-added':
      await replayEntityTypeAdded(event, eventBus, logger);
      stats.entityTypesAdded++;
      break;

    case 'yield:created':
      await replayResourceCreated(event, eventBus, resolveBlob, contentStore, logger);
      stats.resourcesCreated++;
      break;

    case 'mark:added':
      await replayAnnotationAdded(event, eventBus, logger);
      stats.annotationsCreated++;
      break;

    case 'mark:body-updated':
      await replayAnnotationBodyUpdated(event, eventBus, logger);
      break;

    case 'mark:removed':
      await replayAnnotationRemoved(event, eventBus, logger);
      break;

    case 'mark:archived':
      await replayResourceArchived(event, eventBus, logger);
      break;

    case 'mark:unarchived':
      await replayResourceUnarchived(event, eventBus, logger);
      break;

    case 'mark:entity-tag-added':
    case 'mark:entity-tag-removed':
      await replayEntityTagChange(event, eventStore, logger);
      break;

    // Job events are transient — skip during replay
    case 'job:started':
    case 'job:progress':
    case 'job:completed':
    case 'job:failed':
      logger?.debug('Skipping job event during replay', { type: event.type });
      break;

    // Representation events — content is already stored via yield:created replay
    case 'yield:representation-added':
    case 'yield:representation-removed':
      logger?.debug('Skipping representation event during replay', { type: event.type });
      break;

    default:
      logger?.warn('Unknown event type during replay', { type: (event as PersistedEvent).type });
  }
}

// ── Individual event replay handlers ──

async function replayEntityTypeAdded(
  event: PersistedEvent & { type: 'frame:entity-type-added' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  await busRequest(
    asBusRequestPrimitive(eventBus),
    'frame:add-entity-type',
    { tag: event.payload.entityType, _userId: event.userId },
    REPLAY_TIMEOUT_MS,
  );
  logger?.debug('Replayed entitytype.added', { entityType: event.payload.entityType });
}

async function replayResourceCreated(
  event: PersistedEvent & { type: 'yield:created' },
  eventBus: EventBus,
  resolveBlob: ContentBlobResolver,
  contentStore: WorkingTreeStore,
  logger?: Logger,
): Promise<void> {
  const { payload } = event;

  const blob = resolveBlob(payload.contentChecksum);
  if (!blob) {
    throw new Error(`Missing content blob for checksum ${payload.contentChecksum}`);
  }

  // Write content to disk before emitting on bus (no Buffer on bus).
  // storageUri-first: only derive when the archived event carries none.
  // Replayed formats are not guaranteed registry-valid (the import-leniency
  // invariant) — foreign types derive a .bin name; the event payload keeps
  // the true mediaType.
  const base = baseMediaType(payload.format);
  const resolvedUri = payload.storageUri
    || deriveStorageUri(payload.name, isSupportedMediaType(base) ? base : 'application/octet-stream');
  const stored = await contentStore.store(blob, resolvedUri);

  // Correlation-matched in-process write (busRequest throws on failure/timeout).
  await busRequest(
    asBusRequestPrimitive(eventBus),
    'yield:create',
    {
      name: payload.name,
      storageUri: resolvedUri,
      contentChecksum: stored.checksum,
      byteSize: stored.byteSize,
      format: payload.format as ContentFormat,
      _userId: event.userId,
      language: payload.language,
      entityTypes: payload.entityTypes,
      isDraft: payload.isDraft,
      generatedFrom: payload.generatedFrom,
      generationPrompt: payload.generationPrompt,
    },
    REPLAY_TIMEOUT_MS,
  );
  logger?.debug('Replayed resource.created', { name: payload.name });
}

async function replayAnnotationAdded(
  event: PersistedEvent & { type: 'mark:added' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  await awaitReply(
    eventBus,
    'mark:create',
    {
      annotation: event.payload.annotation as Annotation,
      _userId: event.userId,
      resourceId: event.resourceId as ResourceId,
    },
    'mark:create-ok',
    'mark:create-failed',
    REPLAY_TIMEOUT_MS,
  );
  logger?.debug('Replayed annotation.added', { annotationId: event.payload.annotation.id });
}

async function replayAnnotationBodyUpdated(
  event: PersistedEvent & { type: 'mark:body-updated' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  await awaitReply(
    eventBus,
    'mark:update-body',
    {
      annotationId: event.payload.annotationId as AnnotationId,
      _userId: event.userId,
      resourceId: event.resourceId as ResourceId,
      operations: event.payload.operations,
    },
    'mark:body-updated',
    'mark:body-update-failed',
    REPLAY_TIMEOUT_MS,
  );
  logger?.debug('Replayed annotation.body.updated', { annotationId: event.payload.annotationId });
}

async function replayAnnotationRemoved(
  event: PersistedEvent & { type: 'mark:removed' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  await awaitReply(
    eventBus,
    'mark:delete',
    {
      annotationId: event.payload.annotationId as AnnotationId,
      _userId: event.userId,
      resourceId: event.resourceId as ResourceId,
    },
    'mark:delete-ok',
    'mark:delete-failed',
    REPLAY_TIMEOUT_MS,
  );
  logger?.debug('Replayed annotation.removed', { annotationId: event.payload.annotationId });
}

async function replayResourceArchived(
  event: PersistedEvent & { type: 'mark:archived' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  eventBus.get('mark:archive').next({
    _userId: event.userId,
    resourceId: event.resourceId as ResourceId,
  });
  logger?.debug('Replayed resource.archived', { resourceId: event.resourceId });
}

async function replayResourceUnarchived(
  event: PersistedEvent & { type: 'mark:unarchived' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  eventBus.get('mark:unarchive').next({
    _userId: event.userId,
    resourceId: event.resourceId as ResourceId,
  });
  logger?.debug('Replayed resource.unarchived', { resourceId: event.resourceId });
}

async function replayEntityTagChange(
  event: PersistedEvent & { type: 'mark:entity-tag-added' | 'mark:entity-tag-removed' },
  eventStore: EventStore,
  logger?: Logger,
): Promise<void> {
  // Events are facts, commands are requests (ratified 2026-07-09): copy the
  // historical fact into the target log verbatim — never re-issue
  // mark:update-entity-types. This keeps imports outside the vocabulary gate
  // by construction (pre-gate warts restore as the facts they are, removable
  // via the never-gated removal path) and cannot mint duplicate -added events
  // from a fabricated empty diff base.
  const base = {
    resourceId: event.resourceId as ResourceId,
    userId: event.userId,
    version: event.version,
  };
  if (event.type === 'mark:entity-tag-added') {
    await eventStore.appendEvent({ ...base, type: 'mark:entity-tag-added', payload: event.payload });
  } else {
    await eventStore.appendEvent({ ...base, type: 'mark:entity-tag-removed', payload: event.payload });
  }

  logger?.debug('Replayed entity tag change', { type: event.type, entityType: event.payload.entityType });
}
