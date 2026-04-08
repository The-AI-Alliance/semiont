/**
 * Resource Event Types
 *
 * Event-sourced architecture for resource state management
 * Events are stored in an append-only log (JSONL format)
 *
 * Federation-ready design:
 * - resourceId uses content hashes (doc-sha256:...)
 * - userId uses DID format (did:web:org.com:users:alice)
 * - prevEventHash creates tamper-evident chains
 * - Optional signatures for cross-org verification
 */

import type { components } from './types';
import type { ResourceId, UserId } from './identifiers';

// OpenAPI type used in ResourceAnnotations
type Annotation = components['schemas']['Annotation'];

export interface BaseEvent {
  id: string;                    // Unique event ID (UUID)
  timestamp: string;              // ISO 8601 timestamp (for humans, NOT for ordering)
  resourceId?: ResourceId;        // Optional - present for resource-scoped events, absent for system events
                                  // Use isSystemEvent() / isResourceScopedEvent() type guards for routing
  userId: UserId;                 // DID format: did:web:org.com:users:alice (federation-ready)
  version: number;                // Event schema version
}

// Resource lifecycle events — payloads derived from OpenAPI schemas
export interface ResourceCreatedEvent extends BaseEvent {
  type: 'yield:created';
  payload: components['schemas']['ResourceCreatedPayload'];
}

export interface ResourceClonedEvent extends BaseEvent {
  type: 'yield:cloned';
  payload: components['schemas']['ResourceClonedPayload'];
}

export interface ResourceArchivedEvent extends BaseEvent {
  type: 'mark:archived';
  payload: components['schemas']['ResourceArchivedPayload'];
}

export interface ResourceUnarchivedEvent extends BaseEvent {
  type: 'mark:unarchived';
  payload: components['schemas']['ResourceUnarchivedPayload'];
}

export interface ResourceUpdatedEvent extends BaseEvent {
  type: 'yield:updated';
  resourceId: ResourceId;
  payload: components['schemas']['ResourceUpdatedPayload'];
}

export interface ResourceMovedEvent extends BaseEvent {
  type: 'yield:moved';
  resourceId: ResourceId;
  payload: components['schemas']['ResourceMovedPayload'];
}

export interface RepresentationAddedEvent extends BaseEvent {
  type: 'yield:representation-added';
  resourceId: ResourceId;
  payload: components['schemas']['RepresentationAddedPayload'];
}

export interface RepresentationRemovedEvent extends BaseEvent {
  type: 'yield:representation-removed';
  resourceId: ResourceId;
  payload: components['schemas']['RepresentationRemovedPayload'];
}

// Annotation events — payloads derived from OpenAPI schemas
export interface AnnotationAddedEvent extends BaseEvent {
  type: 'mark:added';
  payload: components['schemas']['AnnotationAddedPayload'];
}

export interface AnnotationRemovedEvent extends BaseEvent {
  type: 'mark:removed';
  payload: components['schemas']['AnnotationRemovedPayload'];
}

// Body operation types — derived from OpenAPI schemas
export type BodyItem = components['schemas']['TextualBody'] | components['schemas']['SpecificResource'];

export type BodyOperation =
  | components['schemas']['BodyOperationAdd']
  | components['schemas']['BodyOperationRemove']
  | components['schemas']['BodyOperationReplace'];

export interface AnnotationBodyUpdatedEvent extends BaseEvent {
  type: 'mark:body-updated';
  payload: components['schemas']['AnnotationBodyUpdatedPayload'];
}

// Job events — payloads derived from OpenAPI schemas
export interface JobStartedEvent extends BaseEvent {
  type: 'job:started';
  resourceId: ResourceId;
  payload: components['schemas']['JobStartedPayload'];
}

export interface JobProgressEvent extends BaseEvent {
  type: 'job:progress';
  resourceId: ResourceId;
  payload: components['schemas']['JobProgressPayload'];
}

export interface JobCompletedEvent extends BaseEvent {
  type: 'job:completed';
  resourceId: ResourceId;
  payload: components['schemas']['JobCompletedPayload'];
}

export interface JobFailedEvent extends BaseEvent {
  type: 'job:failed';
  resourceId: ResourceId;
  payload: components['schemas']['JobFailedPayload'];
}

// Entity tag events — payloads derived from OpenAPI schemas
export interface EntityTagAddedEvent extends BaseEvent {
  type: 'mark:entity-tag-added';
  resourceId: ResourceId;
  payload: components['schemas']['EntityTagChangedPayload'];
}

export interface EntityTagRemovedEvent extends BaseEvent {
  type: 'mark:entity-tag-removed';
  resourceId: ResourceId;
  payload: components['schemas']['EntityTagChangedPayload'];
}

// Embedding events — payloads derived from OpenAPI schemas
export interface EmbeddingComputedEvent extends BaseEvent {
  type: 'embedding:computed';
  resourceId: ResourceId;
  payload: components['schemas']['EmbeddingComputedPayload'];
}

export interface EmbeddingDeletedEvent extends BaseEvent {
  type: 'embedding:deleted';
  resourceId: ResourceId;
  payload: components['schemas']['EmbeddingDeletedPayload'];
}

// Entity type events (global collection) — payload derived from OpenAPI schema
export interface EntityTypeAddedEvent extends BaseEvent {
  type: 'mark:entity-type-added';
  resourceId?: undefined;  // System-level event - no resource scope
  payload: components['schemas']['EntityTypeAddedPayload'];
}

// Union type of all events
export type ResourceEvent =
  | ResourceCreatedEvent
  | ResourceClonedEvent
  | ResourceUpdatedEvent
  | ResourceMovedEvent
  | ResourceArchivedEvent
  | ResourceUnarchivedEvent
  | RepresentationAddedEvent      // Multi-format support
  | RepresentationRemovedEvent    // Multi-format support
  | AnnotationAddedEvent
  | AnnotationRemovedEvent
  | AnnotationBodyUpdatedEvent
  | JobStartedEvent          // Job progress
  | JobProgressEvent         // Job progress
  | JobCompletedEvent        // Job progress
  | JobFailedEvent           // Job progress
  | EntityTagAddedEvent      // Resource-level
  | EntityTagRemovedEvent    // Resource-level
  | EntityTypeAddedEvent    // Global collection
  | EmbeddingComputedEvent  // Vector projection
  | EmbeddingDeletedEvent;  // Vector projection

// Extract just the event type strings from the union
export type ResourceEventType = ResourceEvent['type'];

/** All valid event type strings — derived from the ResourceEvent union at compile time */
const RESOURCE_EVENT_TYPES: Set<string> = new Set<ResourceEventType>([
  'yield:created', 'yield:cloned', 'yield:updated', 'yield:moved',
  'yield:representation-added', 'yield:representation-removed',
  'mark:added', 'mark:removed', 'mark:body-updated',
  'mark:archived', 'mark:unarchived',
  'mark:entity-tag-added', 'mark:entity-tag-removed',
  'mark:entity-type-added',
  'job:started', 'job:progress', 'job:completed', 'job:failed',
  'embedding:computed', 'embedding:deleted',
]);

// System-level events (no resource scope)
export type SystemEvent = EntityTypeAddedEvent;

// Resource-scoped events (require resourceId)
export type ResourceScopedEvent = Exclude<ResourceEvent, SystemEvent>;

// Type guards
export function isResourceEvent(event: any): event is ResourceEvent {
  return event &&
    typeof event.id === 'string' &&
    typeof event.timestamp === 'string' &&
    (event.resourceId === undefined || typeof event.resourceId === 'string') &&
    typeof event.type === 'string' &&
    RESOURCE_EVENT_TYPES.has(event.type);
}

/**
 * Type guard: Check if event is system-level (no resourceId)
 * System events affect global state, not individual resources
 */
export function isSystemEvent(event: ResourceEvent): event is SystemEvent {
  return event.type === 'mark:entity-type-added';
}

/**
 * Type guard: Check if event is resource-scoped (has resourceId)
 * Resource events affect a specific resource's state
 */
export function isResourceScopedEvent(event: ResourceEvent): event is ResourceScopedEvent {
  return !isSystemEvent(event);
}

export function getEventType<T extends ResourceEvent>(
  event: ResourceEvent
): T['type'] {
  return event.type as T['type'];
}

// Event metadata for querying and indexing
export interface EventMetadata {
  sequenceNumber: number;  // Position in the event log (source of truth for ordering)
  streamPosition: number;  // Byte position in JSONL file
  prevEventHash?: string;  // SHA-256 of previous event (chain integrity, null for first event)
  checksum?: string;       // SHA-256 of this event for integrity
}

// Optional signature for federation
export interface EventSignature {
  algorithm: 'ed25519';    // Signature algorithm
  publicKey: string;       // User's public key (base64)
  signature: string;       // Event signature (base64)
  keyId?: string;          // Key identifier for rotation
}

// Event with metadata (as persisted in JSONL and published on EventBus)
export type StoredEvent<T extends ResourceEvent = ResourceEvent> = T & {
  metadata: EventMetadata;
  signature?: EventSignature;  // Optional, for federation (unused in MVP)
};

// Query filters for event retrieval
export interface EventQuery {
  resourceId?: ResourceId;
  userId?: string;
  eventTypes?: ResourceEvent['type'][];
  fromTimestamp?: string;
  toTimestamp?: string;
  fromSequence?: number;
  limit?: number;
}

// Annotation collections for a resource (view storage projection)
// Annotations are NOT part of the resource - they reference the resource
export interface ResourceAnnotations {
  resourceId: ResourceId;       // Which resource these annotations belong to (branded type)
  annotations: Annotation[];    // All annotations (highlights, references, assessments, etc.)
  version: number;              // Event count for this resource's annotation stream
  updatedAt: string;           // Last annotation event timestamp
}