/**
 * Event Catalog
 *
 * Defines all persisted domain event types. Each event is a one-liner
 * that pairs a type string with its OpenAPI-derived payload schema.
 *
 * The ResourceEvent union, type guards, and DOMAIN_EVENT_KEYS array
 * all derive from these definitions — single source of truth.
 */

import type { components } from './types';
import type { ResourceId } from './identifiers';
import type { EventBase, StoredEvent } from './event-base';

// ── Domain event interfaces (one per persisted event type) ─────────────────

// Yield flow
export interface ResourceCreatedEvent extends EventBase { type: 'yield:created'; resourceId: ResourceId; payload: components['schemas']['ResourceCreatedPayload']; }
export interface ResourceClonedEvent extends EventBase { type: 'yield:cloned'; resourceId: ResourceId; payload: components['schemas']['ResourceClonedPayload']; }
export interface ResourceUpdatedEvent extends EventBase { type: 'yield:updated'; resourceId: ResourceId; payload: components['schemas']['ResourceUpdatedPayload']; }
export interface ResourceMovedEvent extends EventBase { type: 'yield:moved'; resourceId: ResourceId; payload: components['schemas']['ResourceMovedPayload']; }
export interface RepresentationAddedEvent extends EventBase { type: 'yield:representation-added'; resourceId: ResourceId; payload: components['schemas']['RepresentationAddedPayload']; }
export interface RepresentationRemovedEvent extends EventBase { type: 'yield:representation-removed'; resourceId: ResourceId; payload: components['schemas']['RepresentationRemovedPayload']; }

// Mark flow
export interface AnnotationAddedEvent extends EventBase { type: 'mark:added'; resourceId: ResourceId; payload: components['schemas']['AnnotationAddedPayload']; }
export interface AnnotationRemovedEvent extends EventBase { type: 'mark:removed'; resourceId: ResourceId; payload: components['schemas']['AnnotationRemovedPayload']; }
export interface AnnotationBodyUpdatedEvent extends EventBase { type: 'mark:body-updated'; resourceId: ResourceId; payload: components['schemas']['AnnotationBodyUpdatedPayload']; }
export interface ResourceArchivedEvent extends EventBase { type: 'mark:archived'; resourceId: ResourceId; payload: components['schemas']['ResourceArchivedPayload']; }
export interface ResourceUnarchivedEvent extends EventBase { type: 'mark:unarchived'; resourceId: ResourceId; payload: components['schemas']['ResourceUnarchivedPayload']; }
export interface EntityTagAddedEvent extends EventBase { type: 'mark:entity-tag-added'; resourceId: ResourceId; payload: components['schemas']['EntityTagChangedPayload']; }
export interface EntityTagRemovedEvent extends EventBase { type: 'mark:entity-tag-removed'; resourceId: ResourceId; payload: components['schemas']['EntityTagChangedPayload']; }
export interface EntityTypeAddedEvent extends EventBase { type: 'mark:entity-type-added'; payload: components['schemas']['EntityTypeAddedPayload']; }

// Job flow
export interface JobStartedEvent extends EventBase { type: 'job:started'; resourceId: ResourceId; payload: components['schemas']['JobStartedPayload']; }
export interface JobProgressEvent extends EventBase { type: 'job:progress'; resourceId: ResourceId; payload: components['schemas']['JobProgressPayload']; }
export interface JobCompletedEvent extends EventBase { type: 'job:completed'; resourceId: ResourceId; payload: components['schemas']['JobCompletedPayload']; }
export interface JobFailedEvent extends EventBase { type: 'job:failed'; resourceId: ResourceId; payload: components['schemas']['JobFailedPayload']; }

// Embedding flow
export interface EmbeddingComputedEvent extends EventBase { type: 'embedding:computed'; resourceId: ResourceId; payload: components['schemas']['EmbeddingComputedPayload']; }
export interface EmbeddingDeletedEvent extends EventBase { type: 'embedding:deleted'; resourceId: ResourceId; payload: components['schemas']['EmbeddingDeletedPayload']; }

// ── ResourceEvent union ──────────────────────────────────────────────────────

export type ResourceEvent =
  | ResourceCreatedEvent | ResourceClonedEvent | ResourceUpdatedEvent | ResourceMovedEvent
  | RepresentationAddedEvent | RepresentationRemovedEvent
  | AnnotationAddedEvent | AnnotationRemovedEvent | AnnotationBodyUpdatedEvent
  | ResourceArchivedEvent | ResourceUnarchivedEvent
  | EntityTagAddedEvent | EntityTagRemovedEvent | EntityTypeAddedEvent
  | JobStartedEvent | JobProgressEvent | JobCompletedEvent | JobFailedEvent
  | EmbeddingComputedEvent | EmbeddingDeletedEvent;

export type ResourceEventType = ResourceEvent['type'];
export type SystemEvent = EntityTypeAddedEvent;
export type ResourceScopedEvent = Exclude<ResourceEvent, SystemEvent>;

/** Helpers for building events generically */
export type ResourceDomainEvent<Type extends string, Payload> =
  StoredEvent<EventBase & { type: Type; payload: Payload; resourceId: ResourceId }>;
export type SystemDomainEvent<Type extends string, Payload> =
  StoredEvent<EventBase & { type: Type; payload: Payload }>;

/** Input type for appendEvent — ResourceEvent without id/timestamp (assigned at persistence time) */
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
