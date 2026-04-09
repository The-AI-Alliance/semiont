/**
 * Persisted Events
 *
 * The 20 event types that get appended to the JSONL event log.
 * Each maps a type string to its OpenAPI payload schema.
 * The PersistedEvent union derives from this catalog.
 */

import type { components } from './types';
import type { ResourceId } from './identifiers';
import type { EventBase } from './event-base';

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
  'mark:added': components['schemas']['AnnotationAddedPayload'];
  'mark:removed': components['schemas']['AnnotationRemovedPayload'];
  'mark:body-updated': components['schemas']['AnnotationBodyUpdatedPayload'];
  'mark:archived': components['schemas']['ResourceArchivedPayload'];
  'mark:unarchived': components['schemas']['ResourceUnarchivedPayload'];
  'mark:entity-tag-added': components['schemas']['EntityTagChangedPayload'];
  'mark:entity-tag-removed': components['schemas']['EntityTagChangedPayload'];
  'mark:entity-type-added': components['schemas']['EntityTypeAddedPayload'];
  'job:started': components['schemas']['JobStartedPayload'];
  'job:progress': components['schemas']['JobProgressPayload'];
  'job:completed': components['schemas']['JobCompletedPayload'];
  'job:failed': components['schemas']['JobFailedPayload'];
  'embedding:computed': components['schemas']['EmbeddingComputedPayload'];
  'embedding:deleted': components['schemas']['EmbeddingDeletedPayload'];
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

/** Input type for appendEvent — PersistedEvent without id/timestamp (assigned at persistence time). */
export type EventInput = Omit<PersistedEvent, 'id' | 'timestamp'>;
