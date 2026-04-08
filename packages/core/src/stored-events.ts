/**
 * Stored Event Types
 *
 * Core types for the event-sourced persistence model.
 * Defines EventBase, StoredEvent, EventMetadata, domain event helpers,
 * the ResourceEvent union, and type guards.
 *
 * The EventMap entries (wire-protocol.ts, actor-protocol.ts, ui-events.ts)
 * reference types from this file. This file has no dependency on EventMap.
 */

import type { components } from './types';
import type { ResourceId, UserId } from './identifiers';
import { DOMAIN_EVENT_KEYS } from './wire-protocol';

// ── Core event shape ─────────────────────────────────────────────────────────

/** Fields common to ALL events (system and resource-scoped) */
export interface EventBase {
  id: string;                    // Unique event ID (UUID)
  timestamp: string;             // ISO 8601 timestamp (for humans, NOT for ordering)
  resourceId?: ResourceId;       // Present for resource-scoped events, absent for system events
  userId: UserId;                // DID format: did:web:org.com:users:alice
  version: number;               // Event schema version
}

export interface EventMetadata {
  sequenceNumber: number;        // Position in event log (ordering authority)
  streamPosition: number;        // Byte offset in JSONL file
  prevEventHash?: string;        // SHA-256 of previous event (hash chain)
  checksum?: string;             // SHA-256 of this event (integrity)
}

export interface EventSignature {
  algorithm: 'ed25519';
  publicKey: string;
  signature: string;
  keyId?: string;
}

// ── StoredEvent: flat intersection of event + metadata ───────────────────────

export type StoredEvent<T extends EventBase = ResourceEvent> = T & {
  metadata: EventMetadata;
  signature?: EventSignature;
};

// ── Domain event helpers ─────────────────────────────────────────────────────

/** A resource-scoped domain event. Has a required resourceId. */
export type ResourceDomainEvent<Type extends string, Payload> =
  StoredEvent<EventBase & { type: Type; payload: Payload; resourceId: ResourceId }>;

/** A system-level domain event. No resourceId field. */
export type SystemDomainEvent<Type extends string, Payload> =
  StoredEvent<EventBase & { type: Type; payload: Payload }>;

// ── Resource event interfaces (one per persisted event type) ─────────────────

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

/** Input type for appendEvent — ResourceEvent without id/timestamp (assigned at persistence time) */
export type EventInput = Omit<ResourceEvent, 'id' | 'timestamp'>;

// ── Body operation types (OpenAPI-derived) ───────────────────────────────────

export type BodyItem = components['schemas']['TextualBody'] | components['schemas']['SpecificResource'];

export type BodyOperation =
  | components['schemas']['BodyOperationAdd']
  | components['schemas']['BodyOperationRemove']
  | components['schemas']['BodyOperationReplace'];

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

// ── Query and view types ─────────────────────────────────────────────────────

type Annotation = components['schemas']['Annotation'];

export interface EventQuery {
  resourceId?: ResourceId;
  userId?: string;
  eventTypes?: ResourceEvent['type'][];
  fromTimestamp?: string;
  toTimestamp?: string;
  fromSequence?: number;
  limit?: number;
}

export interface ResourceAnnotations {
  resourceId: ResourceId;
  annotations: Annotation[];
  version: number;
  updatedAt: string;
}
