/**
 * Persisted Events
 *
 * The 18 event types that get appended to the JSONL event log.
 * Each maps a type string to its OpenAPI payload schema.
 * The PersistedEvent union derives from this catalog.
 */

import type { components } from './types';
import type { AnnotationId, ResourceId } from './identifiers';
import type { Annotation } from './annotation-types';
import type { EventBase } from './event-base';

// Branded payload overrides — the OpenAPI schemas reference the raw
// `Annotation` type with `id: string`. At the TypeScript layer we narrow
// to the branded `Annotation` so consumers read `payload.annotation.id`
// as `AnnotationId` without an upcast at every seam.
type AnnotationAddedPayload =
  components['schemas']['AnnotationAddedPayload'] & { annotation: Annotation };
type AnnotationRemovedPayload =
  components['schemas']['AnnotationRemovedPayload'] & { annotationId: AnnotationId };
type AnnotationBodyUpdatedPayload =
  components['schemas']['AnnotationBodyUpdatedPayload'] & { annotationId: AnnotationId };

// ── The Catalog ──────────────────────────────────────────────────────────────

/**
 * Maps each persisted event type string to its OpenAPI payload schema.
 * Single source of truth for "what events get written to the log."
 */
type PersistedEventCatalog = {
  'yield:created': components['schemas']['ResourceCreatedPayload'];
  'yield:cloned': components['schemas']['ResourceClonedPayload'];
  'yield:updated': components['schemas']['ResourceUpdatedPayload'];
  'yield:moved': components['schemas']['ResourceMovedPayload'];
  'yield:representation-added': components['schemas']['RepresentationAddedPayload'];
  'yield:representation-removed': components['schemas']['RepresentationRemovedPayload'];
  'mark:added': AnnotationAddedPayload;
  'mark:removed': AnnotationRemovedPayload;
  'mark:body-updated': AnnotationBodyUpdatedPayload;
  'mark:archived': components['schemas']['ResourceArchivedPayload'];
  'mark:unarchived': components['schemas']['ResourceUnarchivedPayload'];
  'mark:entity-tag-added': components['schemas']['EntityTagChangedPayload'];
  'mark:entity-tag-removed': components['schemas']['EntityTagChangedPayload'];
  'mark:entity-type-added': components['schemas']['EntityTypeAddedPayload'];
  'job:started': components['schemas']['JobStartedPayload'];
  'job:progress': components['schemas']['JobProgressPayload'];
  'job:completed': components['schemas']['JobCompletedPayload'];
  'job:failed': components['schemas']['JobFailedPayload'];
};

// ── Derived types ────────────────────────────────────────────────────────────

/** System event types — persisted events that have no resourceId. */
type SystemEventType = 'mark:entity-type-added';

/** Extract the concrete persisted event type for a given type string. */
export type EventOfType<K extends keyof PersistedEventCatalog> =
  K extends SystemEventType
    ? EventBase & { type: K; payload: PersistedEventCatalog[K] }
    : EventBase & { type: K; resourceId: ResourceId; payload: PersistedEventCatalog[K] };

/** The union of all 20 persisted event types. Discriminated on `type`. */
export type PersistedEvent = {
  [K in keyof PersistedEventCatalog]: EventOfType<K>
}[keyof PersistedEventCatalog];

export type PersistedEventType = PersistedEvent['type'];

/**
 * Runtime list of every persisted event type.
 *
 * Single source of truth for code that needs to enumerate event types at
 * runtime — most importantly the per-resource `events-stream` SSE route,
 * which subscribes to all of them. The exhaustiveness check below makes
 * it impossible to add a new member to `PersistedEventCatalog` without
 * also adding it here: forgetting fails to typecheck rather than silently
 * dropping the event from the events-stream.
 */
export const PERSISTED_EVENT_TYPES = [
  'yield:created',
  'yield:cloned',
  'yield:updated',
  'yield:moved',
  'yield:representation-added',
  'yield:representation-removed',
  'mark:added',
  'mark:removed',
  'mark:body-updated',
  'mark:archived',
  'mark:unarchived',
  'mark:entity-tag-added',
  'mark:entity-tag-removed',
  'mark:entity-type-added',
  'job:started',
  'job:progress',
  'job:completed',
  'job:failed',
] as const satisfies readonly PersistedEventType[];

// Compile-time exhaustiveness: if PersistedEventType gains a member that
// PERSISTED_EVENT_TYPES is missing, this assignment fails to typecheck.
// The ERROR object names the missing-member case so the build error is
// self-explanatory.
type _ExhaustivePersistedEventTypes =
  Exclude<PersistedEventType, typeof PERSISTED_EVENT_TYPES[number]> extends never
    ? true
    : { ERROR: 'PERSISTED_EVENT_TYPES is missing members of PersistedEventType' };
const _persistedEventTypesExhaustive: _ExhaustivePersistedEventTypes = true;
void _persistedEventTypesExhaustive;

/** Input type for appendEvent — PersistedEvent without id/timestamp (assigned at persistence time). */
export type EventInput = Omit<PersistedEvent, 'id' | 'timestamp'>;
