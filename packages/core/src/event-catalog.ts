/**
 * Event Catalog
 *
 * Maps every persisted domain event type to its OpenAPI payload schema.
 * The ResourceEvent union, type guards, and DOMAIN_EVENT_KEYS array
 * all derive from this single catalog — one source of truth.
 *
 * Named event interfaces (AnnotationAddedEvent, etc.) are gone.
 * Use EventOfType<'mark:added'> instead.
 */

import type { components } from './types';
import type { ResourceId } from './identifiers';
import type { EventBase } from './event-base';

// ── The Catalog ──────────────────────────────────────────────────────────────

/**
 * Maps each domain event type string to its OpenAPI payload schema.
 * This is the single source of truth for "what events exist and what they carry."
 */
type EventCatalog = {
  // Yield flow
  'yield:created': components['schemas']['ResourceCreatedPayload'];
  'yield:cloned': components['schemas']['ResourceClonedPayload'];
  'yield:updated': components['schemas']['ResourceUpdatedPayload'];
  'yield:moved': components['schemas']['ResourceMovedPayload'];
  'yield:representation-added': components['schemas']['RepresentationAddedPayload'];
  'yield:representation-removed': components['schemas']['RepresentationRemovedPayload'];

  // Mark flow
  'mark:added': components['schemas']['AnnotationAddedPayload'];
  'mark:removed': components['schemas']['AnnotationRemovedPayload'];
  'mark:body-updated': components['schemas']['AnnotationBodyUpdatedPayload'];
  'mark:archived': components['schemas']['ResourceArchivedPayload'];
  'mark:unarchived': components['schemas']['ResourceUnarchivedPayload'];
  'mark:entity-tag-added': components['schemas']['EntityTagChangedPayload'];
  'mark:entity-tag-removed': components['schemas']['EntityTagChangedPayload'];
  'mark:entity-type-added': components['schemas']['EntityTypeAddedPayload'];

  // Job flow
  'job:started': components['schemas']['JobStartedPayload'];
  'job:progress': components['schemas']['JobProgressPayload'];
  'job:completed': components['schemas']['JobCompletedPayload'];
  'job:failed': components['schemas']['JobFailedPayload'];

  // Embedding flow
  'embedding:computed': components['schemas']['EmbeddingComputedPayload'];
  'embedding:deleted': components['schemas']['EmbeddingDeletedPayload'];
};

// ── Derived types ────────────────────────────────────────────────────────────

/** A resource-scoped domain event: EventBase + type discriminant + payload. */
type ResourceScopedEventOf<K extends keyof EventCatalog> =
  EventBase & { type: K; resourceId: ResourceId; payload: EventCatalog[K] };

/** A system-level domain event (no resourceId). Currently only mark:entity-type-added. */
type SystemEventOf<K extends keyof EventCatalog> =
  EventBase & { type: K; payload: EventCatalog[K] };

/** System event types — events that have no resourceId. */
type SystemEventType = 'mark:entity-type-added';

/**
 * Extract the concrete event type for a given event type string.
 *
 * @example
 * type Added = EventOfType<'mark:added'>;
 * // = EventBase & { type: 'mark:added'; resourceId: ResourceId; payload: AnnotationAddedPayload }
 */
export type EventOfType<K extends keyof EventCatalog> =
  K extends SystemEventType ? SystemEventOf<K> : ResourceScopedEventOf<K>;

/** The union of all persisted domain events. Discriminated on `type`. */
export type ResourceEvent = {
  [K in keyof EventCatalog]: EventOfType<K>
}[keyof EventCatalog];

export type ResourceEventType = ResourceEvent['type'];

/** System events — no resourceId. */
export type SystemEvent = EventOfType<'mark:entity-type-added'>;

/** Resource-scoped events — have a required resourceId. */
export type ResourceScopedEvent = Exclude<ResourceEvent, SystemEvent>;

/** Input type for appendEvent — ResourceEvent without id/timestamp (assigned at persistence time). */
export type EventInput = Omit<ResourceEvent, 'id' | 'timestamp'>;

// ── Domain event key list ────────────────────────────────────────────────────

/** All persisted domain event type strings. Used for runtime validation. */
export const DOMAIN_EVENT_KEYS = [
  'yield:created', 'yield:cloned', 'yield:updated', 'yield:moved',
  'yield:representation-added', 'yield:representation-removed',
  'mark:added', 'mark:removed', 'mark:body-updated',
  'mark:archived', 'mark:unarchived',
  'mark:entity-tag-added', 'mark:entity-tag-removed',
  'mark:entity-type-added',
  'job:started', 'job:progress', 'job:completed', 'job:failed',
  'embedding:computed', 'embedding:deleted',
] as const;

export type DomainEventKey = typeof DOMAIN_EVENT_KEYS[number];

// ── Type guards ──────────────────────────────────────────────────────────────

const DOMAIN_EVENT_TYPES: Set<string> = new Set(DOMAIN_EVENT_KEYS);

export function isResourceEvent(event: unknown): event is ResourceEvent {
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.timestamp === 'string' &&
    (e.resourceId === undefined || typeof e.resourceId === 'string') &&
    typeof e.type === 'string' &&
    DOMAIN_EVENT_TYPES.has(e.type)
  );
}

export function isSystemEvent(event: ResourceEvent): boolean {
  return event.type === 'mark:entity-type-added';
}

export function isResourceScopedEvent(event: ResourceEvent): boolean {
  return !isSystemEvent(event);
}

export function getEventType<T extends ResourceEvent>(event: ResourceEvent): T['type'] {
  return event.type as T['type'];
}
