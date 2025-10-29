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

import type { CreationMethod } from './creation-methods';
import type { components } from '@semiont/api-client';

// Import OpenAPI types
type Annotation = components['schemas']['Annotation'];
type ContentFormat = components['schemas']['ContentFormat'];

export interface BaseEvent {
  id: string;                    // Unique event ID (UUID)
  timestamp: string;              // ISO 8601 timestamp (for humans, NOT for ordering)
  resourceId?: string;            // Optional - present for resource-scoped events, absent for system events
                                  // ⚠️ BRITTLE: Event routing depends on presence/absence of this field
                                  // TODO: Add explicit projection target field for cleaner routing
  userId: string;                 // DID format: did:web:org.com:users:alice (federation-ready)
  version: number;                // Event schema version
}

// Resource lifecycle events
export interface ResourceCreatedEvent extends BaseEvent {
  type: 'resource.created';
  payload: {
    name: string;
    format: ContentFormat;       // MIME type (validated enum)
    contentChecksum: string;     // SHA-256 of content (should match resourceId)
    creationMethod: CreationMethod;  // How the resource was created
    entityTypes?: string[];

    // First-class fields (promoted from metadata)
    language?: string;             // Language/locale code (e.g., 'en', 'es', 'fr')
    isDraft?: boolean;           // Draft status for generated resources
    generatedFrom?: string;      // Annotation/Reference ID that triggered generation
    generationPrompt?: string;   // Prompt used for AI generation (events-only, not on Resource)
  };
}

export interface ResourceClonedEvent extends BaseEvent {
  type: 'resource.cloned';
  payload: {
    name: string;
    format: ContentFormat;       // MIME type (validated enum)
    contentChecksum: string;     // SHA-256 of new content
    parentResourceId: string;   // Content hash of parent resource
    creationMethod: CreationMethod;  // How the resource was created
    entityTypes?: string[];

    // First-class fields (promoted from metadata)
    language?: string;             // Language/locale code (e.g., 'en', 'es', 'fr')
  };
}

export interface ResourceArchivedEvent extends BaseEvent {
  type: 'resource.archived';
  payload: {
    reason?: string;
  };
}

export interface ResourceUnarchivedEvent extends BaseEvent {
  type: 'resource.unarchived';
  payload: Record<string, never>;  // Empty payload
}

// Unified annotation events
// Single principle: An annotation is an annotation. The motivation field tells you what kind it is.
export interface AnnotationAddedEvent extends BaseEvent {
  type: 'annotation.added';
  payload: {
    annotation: Omit<Annotation, 'creator' | 'created'>;  // W3C Annotation (creator/created come from event metadata)
  };
}

export interface AnnotationRemovedEvent extends BaseEvent {
  type: 'annotation.removed';
  payload: {
    annotationId: string;           // Unified ID field
  };
}

// Body operation types for fine-grained annotation body modifications
export type BodyItem =
  | { type: 'TextualBody'; value: string; purpose: 'tagging' | 'commenting' | 'describing'; format?: string; language?: string }
  | { type: 'SpecificResource'; source: string; purpose: 'linking' };

export type BodyOperation =
  | { op: 'add'; item: BodyItem }
  | { op: 'remove'; item: BodyItem }
  | { op: 'replace'; oldItem: BodyItem; newItem: BodyItem };

export interface AnnotationBodyUpdatedEvent extends BaseEvent {
  type: 'annotation.body.updated';
  payload: {
    annotationId: string;
    operations: BodyOperation[];
  };
}

// Entity tag events (resource-level)
export interface EntityTagAddedEvent extends BaseEvent {
  type: 'entitytag.added';
  resourceId: string;  // Required - resource-scoped event
  payload: {
    entityType: string;
  };
}

export interface EntityTagRemovedEvent extends BaseEvent {
  type: 'entitytag.removed';
  resourceId: string;  // Required - resource-scoped event
  payload: {
    entityType: string;
  };
}

// Entity type events (global collection)
export interface EntityTypeAddedEvent extends BaseEvent {
  type: 'entitytype.added';
  resourceId?: undefined;  // System-level event - no resource scope
  payload: {
    entityType: string;  // The entity type being added to global collection
  };
}

// Union type of all events
export type ResourceEvent =
  | ResourceCreatedEvent
  | ResourceClonedEvent
  | ResourceArchivedEvent
  | ResourceUnarchivedEvent
  | AnnotationAddedEvent
  | AnnotationRemovedEvent
  | AnnotationBodyUpdatedEvent
  | EntityTagAddedEvent      // Resource-level
  | EntityTagRemovedEvent    // Resource-level
  | EntityTypeAddedEvent;    // Global collection

// Extract just the event type strings from the union
export type ResourceEventType = ResourceEvent['type'];

// Type guards
export function isResourceEvent(event: any): event is ResourceEvent {
  return event &&
    typeof event.id === 'string' &&
    typeof event.timestamp === 'string' &&
    (event.resourceId === undefined || typeof event.resourceId === 'string') &&  // resourceId now optional
    typeof event.type === 'string' &&
    event.type.includes('.');
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
  timestamp: string;       // When stored (for humans, not ordering)
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

// Event with metadata (as stored)
export interface StoredEvent<T extends ResourceEvent = ResourceEvent> {
  event: T;
  metadata: EventMetadata;
  signature?: EventSignature;  // Optional, for federation (unused in MVP)
}

// Query filters for event retrieval
export interface EventQuery {
  resourceId?: string;
  userId?: string;
  eventTypes?: ResourceEvent['type'][];
  fromTimestamp?: string;
  toTimestamp?: string;
  fromSequence?: number;
  limit?: number;
}

// Annotation collections for a resource (Layer 3 projection)
// Annotations are NOT part of the resource - they reference the resource
export interface ResourceAnnotations {
  resourceId: string;           // Which resource these annotations belong to
  annotations: Annotation[];    // All annotations (highlights, references, assessments, etc.)
  version: number;              // Event count for this resource's annotation stream
  updatedAt: string;           // Last annotation event timestamp
}