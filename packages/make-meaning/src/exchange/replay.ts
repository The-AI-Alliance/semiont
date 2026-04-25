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

import { firstValueFrom, race, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Logger, StoredEvent, PersistedEvent, ResourceId, AnnotationId } from '@semiont/core';
import { EventBus } from '@semiont/core';
import type { components } from '@semiont/core';
import type { WorkingTreeStore } from '@semiont/content';
import { deriveStorageUri } from '@semiont/content';

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
    await replayEvent(stored, eventBus, resolveBlob, contentStore, stats, logger);
    stats.eventsReplayed++;
  }

  return { stats };
}

async function replayEvent(
  event: PersistedEvent,
  eventBus: EventBus,
  resolveBlob: ContentBlobResolver,
  contentStore: WorkingTreeStore,
  stats: ReplayStats,
  logger?: Logger,
): Promise<void> {
  switch (event.type) {
    case 'mark:entity-type-added':
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
      await replayEntityTagChange(event, eventBus, logger);
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
  event: PersistedEvent & { type: 'mark:entity-type-added' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  const result$ = race(
    eventBus.get('mark:entity-type-added').pipe(map(() => 'ok' as const)),
    eventBus.get('mark:entity-type-add-failed').pipe(map((e) => { throw new Error(e.message); })),
    timer(REPLAY_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for mark:entity-type-added'); })),
  );

  eventBus.get('mark:add-entity-type').next({
    tag: event.payload.entityType,
    _userId: event.userId,
  });

  await firstValueFrom(result$);
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

  // Write content to disk before emitting on bus (no Buffer on bus)
  const resolvedUri = payload.storageUri || deriveStorageUri(payload.name, payload.format);
  const stored = await contentStore.store(blob, resolvedUri);

  const result$ = race(
    eventBus.get('yield:create-ok').pipe(map((r) => r)),
    eventBus.get('yield:create-failed').pipe(map((e) => { throw new Error(e.message); })),
    timer(REPLAY_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for yield:create-ok'); })),
  );

  eventBus.get('yield:create').next({
    name: payload.name,
    storageUri: resolvedUri,
    contentChecksum: stored.checksum,
    byteSize: stored.byteSize,
    format: payload.format as ContentFormat,
    _userId: event.userId,
    language: payload.language,
    entityTypes: payload.entityTypes,
    creationMethod: payload.creationMethod,
    isDraft: payload.isDraft,
    generatedFrom: payload.generatedFrom,
    generationPrompt: payload.generationPrompt,
  });

  await firstValueFrom(result$);
  logger?.debug('Replayed resource.created', { name: payload.name });
}

async function replayAnnotationAdded(
  event: PersistedEvent & { type: 'mark:added' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  const result$ = race(
    eventBus.get('mark:create-ok').pipe(map(() => 'ok' as const)),
    eventBus.get('mark:create-failed').pipe(map((e) => { throw new Error(e.message); })),
    timer(REPLAY_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for mark:create-ok'); })),
  );

  eventBus.get('mark:create').next({
    annotation: event.payload.annotation as Annotation,
    _userId: event.userId,
    resourceId: event.resourceId as ResourceId,
  });

  await firstValueFrom(result$);
  logger?.debug('Replayed annotation.added', { annotationId: event.payload.annotation.id });
}

async function replayAnnotationBodyUpdated(
  event: PersistedEvent & { type: 'mark:body-updated' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  const result$ = race(
    eventBus.get('mark:body-updated').pipe(map(() => 'ok' as const)),
    eventBus.get('mark:body-update-failed').pipe(map((e) => { throw new Error(e.message); })),
    timer(REPLAY_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for mark:body-updated'); })),
  );

  eventBus.get('mark:update-body').next({
    annotationId: event.payload.annotationId as AnnotationId,
    _userId: event.userId,
    resourceId: event.resourceId as ResourceId,
    operations: event.payload.operations,
  });

  await firstValueFrom(result$);
  logger?.debug('Replayed annotation.body.updated', { annotationId: event.payload.annotationId });
}

async function replayAnnotationRemoved(
  event: PersistedEvent & { type: 'mark:removed' },
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  const result$ = race(
    eventBus.get('mark:delete-ok').pipe(map(() => 'ok' as const)),
    eventBus.get('mark:delete-failed').pipe(map((e) => { throw new Error(e.message); })),
    timer(REPLAY_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for mark:delete-ok'); })),
  );

  eventBus.get('mark:delete').next({
    annotationId: event.payload.annotationId as AnnotationId,
    _userId: event.userId,
    resourceId: event.resourceId as ResourceId,
  });

  await firstValueFrom(result$);
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
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  const resourceId = event.resourceId as ResourceId;
  const entityType = event.payload.entityType;

  if (event.type === 'mark:entity-tag-added') {
    eventBus.get('mark:update-entity-types').next({
      resourceId,
      _userId: event.userId,
      currentEntityTypes: [],
      updatedEntityTypes: [entityType],
    });
  } else {
    eventBus.get('mark:update-entity-types').next({
      resourceId,
      _userId: event.userId,
      currentEntityTypes: [entityType],
      updatedEntityTypes: [],
    });
  }

  logger?.debug('Replayed entity tag change', { type: event.type, entityType });
}
