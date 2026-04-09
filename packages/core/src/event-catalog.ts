/**
 * Event Catalog
 *
 * Maps every persisted domain event type to its OpenAPI payload schema.
 * The ResourceEvent union derives from this single catalog.
 */

import type { components } from './types';
import type { ResourceId } from './identifiers';
import type { EventBase } from './event-base';

// ── The Catalog ──────────────────────────────────────────────────────────────

/**
 * Maps each domain event type string to its OpenAPI payload schema.
 * Single source of truth for "what events exist and what they carry."
 */
type EventCatalog = {
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

/** System event types — events that have no resourceId. */
type SystemEventType = 'mark:entity-type-added';

/** Extract the concrete event type for a given event type string. */
export type EventOfType<K extends keyof EventCatalog> =
  K extends SystemEventType
    ? EventBase & { type: K; payload: EventCatalog[K] }
    : EventBase & { type: K; resourceId: ResourceId; payload: EventCatalog[K] };

/** The union of all persisted domain events. Discriminated on `type`. */
export type ResourceEvent = {
  [K in keyof EventCatalog]: EventOfType<K>
}[keyof EventCatalog];

export type ResourceEventType = ResourceEvent['type'];

/** Input type for appendEvent — ResourceEvent without id/timestamp (assigned at persistence time). */
export type EventInput = Omit<ResourceEvent, 'id' | 'timestamp'>;
