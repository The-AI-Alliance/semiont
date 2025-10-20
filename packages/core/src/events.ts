/**
 * Document Event Types
 *
 * Event-sourced architecture for document state management
 * Events are stored in an append-only log (JSONL format)
 *
 * Federation-ready design:
 * - documentId uses content hashes (doc-sha256:...)
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
  documentId: string;             // Content hash: doc-sha256:abc... (federation-ready)
  userId: string;                 // DID format: did:web:org.com:users:alice (federation-ready)
  version: number;                // Event schema version
}

// Document lifecycle events
export interface DocumentCreatedEvent extends BaseEvent {
  type: 'document.created';
  payload: {
    name: string;
    format: ContentFormat;       // MIME type (validated enum)
    contentHash: string;        // SHA-256 of content (should match documentId)
    creationMethod: CreationMethod;  // How the document was created
    entityTypes?: string[];

    // First-class fields (promoted from metadata)
    locale?: string;             // Language/locale code (e.g., 'en', 'es', 'fr')
    isDraft?: boolean;           // Draft status for generated documents
    generatedFrom?: string;      // Annotation/Reference ID that triggered generation
    generationPrompt?: string;   // Prompt used for AI generation (events-only, not on Document)
  };
}

export interface DocumentClonedEvent extends BaseEvent {
  type: 'document.cloned';
  payload: {
    name: string;
    format: ContentFormat;       // MIME type (validated enum)
    contentHash: string;        // SHA-256 of new content
    parentDocumentId: string;   // Content hash of parent document
    creationMethod: CreationMethod;  // How the document was created
    entityTypes?: string[];

    // First-class fields (promoted from metadata)
    locale?: string;             // Language/locale code (e.g., 'en', 'es', 'fr')
  };
}

export interface DocumentArchivedEvent extends BaseEvent {
  type: 'document.archived';
  payload: {
    reason?: string;
  };
}

export interface DocumentUnarchivedEvent extends BaseEvent {
  type: 'document.unarchived';
  payload: Record<string, never>;  // Empty payload
}

// Highlight events
export interface HighlightAddedEvent extends BaseEvent {
  type: 'highlight.added';
  payload: {
    highlightId: string;
    exact: string;  // W3C Web Annotation standard
    position: {
      offset: number;
      length: number;
    };
  };
}

export interface HighlightRemovedEvent extends BaseEvent {
  type: 'highlight.removed';
  payload: {
    highlightId: string;
  };
}

// Reference events
export interface ReferenceCreatedEvent extends BaseEvent {
  type: 'reference.created';
  payload: {
    referenceId: string;
    exact: string;  // W3C Web Annotation standard
    position: {
      offset: number;
      length: number;
    };
    entityTypes?: string[];
    targetDocumentId?: string;  // Content hash of target doc (if null, it's a stub reference)
  };
}

export interface ReferenceResolvedEvent extends BaseEvent {
  type: 'reference.resolved';
  payload: {
    referenceId: string;
    targetDocumentId: string;   // Content hash of target document
  };
}

export interface ReferenceDeletedEvent extends BaseEvent {
  type: 'reference.deleted';
  payload: {
    referenceId: string;
  };
}

// Entity tag events
export interface EntityTagAddedEvent extends BaseEvent {
  type: 'entitytag.added';
  payload: {
    entityType: string;
  };
}

export interface EntityTagRemovedEvent extends BaseEvent {
  type: 'entitytag.removed';
  payload: {
    entityType: string;
  };
}

// Assessment events (W3C motivation 'assessing' - for errors, warnings, issues)
export interface AssessmentAddedEvent extends BaseEvent {
  type: 'assessment.added';
  payload: {
    assessmentId: string;
    exact: string;  // W3C Web Annotation standard
    position: {
      offset: number;
      length: number;
    };
    value?: string;  // Optional assessment message/description
  };
}

export interface AssessmentRemovedEvent extends BaseEvent {
  type: 'assessment.removed';
  payload: {
    assessmentId: string;
  };
}

// Union type of all events
export type DocumentEvent =
  | DocumentCreatedEvent
  | DocumentClonedEvent
  | DocumentArchivedEvent
  | DocumentUnarchivedEvent
  | HighlightAddedEvent
  | HighlightRemovedEvent
  | ReferenceCreatedEvent
  | ReferenceResolvedEvent
  | ReferenceDeletedEvent
  | EntityTagAddedEvent
  | EntityTagRemovedEvent
  | AssessmentAddedEvent
  | AssessmentRemovedEvent;

// Extract just the event type strings from the union
export type DocumentEventType = DocumentEvent['type'];

// Type guards
export function isDocumentEvent(event: any): event is DocumentEvent {
  return event &&
    typeof event.id === 'string' &&
    typeof event.timestamp === 'string' &&
    typeof event.documentId === 'string' &&
    typeof event.type === 'string' &&
    event.type.includes('.');
}

export function getEventType<T extends DocumentEvent>(
  event: DocumentEvent
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
export interface StoredEvent<T extends DocumentEvent = DocumentEvent> {
  event: T;
  metadata: EventMetadata;
  signature?: EventSignature;  // Optional, for federation (unused in MVP)
}

// Query filters for event retrieval
export interface EventQuery {
  documentId?: string;
  userId?: string;
  eventTypes?: DocumentEvent['type'][];
  fromTimestamp?: string;
  toTimestamp?: string;
  fromSequence?: number;
  limit?: number;
}

// Annotation collections for a document (Layer 3 projection)
// Annotations are NOT part of the document - they reference the document
export interface DocumentAnnotations {
  documentId: string;           // Which document these annotations belong to
  highlights: Annotation[];     // Full Annotation objects
  references: Annotation[];     // Full Annotation objects
  version: number;              // Event count for this document's annotation stream
  updatedAt: string;           // Last annotation event timestamp
}