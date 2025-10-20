/**
 * Zod schemas for document events
 *
 * These schemas provide runtime validation for event types defined in events.ts
 * Kept in sync with TypeScript interfaces for type safety
 */

import { z } from 'zod';
import { CREATION_METHODS } from './creation-methods';
import { ContentFormatSchema } from './base-schemas';

// Document lifecycle event payloads
export const DocumentCreatedPayloadSchema = z.object({
  name: z.string(),
  format: ContentFormatSchema, // MIME type (validated enum)
  contentChecksum: z.string(),
  creationMethod: z.enum([
    CREATION_METHODS.API,
    CREATION_METHODS.UPLOAD,
    CREATION_METHODS.UI,
    CREATION_METHODS.REFERENCE,
    CREATION_METHODS.CLONE,
    CREATION_METHODS.GENERATED,
  ] as const),
  entityTypes: z.array(z.string()).optional(),

  // New first-class fields (promoted from metadata)
  locale: z.string().optional(),
  isDraft: z.boolean().optional(),
  generatedFrom: z.string().optional(),
  generationPrompt: z.string().optional(),
});

export const DocumentClonedPayloadSchema = z.object({
  name: z.string(),
  format: ContentFormatSchema, // MIME type (validated enum)
  contentChecksum: z.string(),
  parentDocumentId: z.string(),
  creationMethod: z.enum([
    CREATION_METHODS.API,
    CREATION_METHODS.UPLOAD,
    CREATION_METHODS.UI,
    CREATION_METHODS.REFERENCE,
    CREATION_METHODS.CLONE,
    CREATION_METHODS.GENERATED,
  ] as const),
  entityTypes: z.array(z.string()).optional(),

  // New first-class fields (promoted from metadata)
  locale: z.string().optional(),
});

export const DocumentArchivedPayloadSchema = z.object({
  reason: z.string().optional(),
});

export const DocumentUnarchivedPayloadSchema = z.object({});

// Highlight event payloads
export const HighlightAddedPayloadSchema = z.object({
  highlightId: z.string(),
  exact: z.string(),  // W3C Web Annotation standard
  position: z.object({
    offset: z.number(),
    length: z.number(),
  }),
});

export const HighlightRemovedPayloadSchema = z.object({
  highlightId: z.string(),
});

// Reference event payloads
export const ReferenceCreatedPayloadSchema = z.object({
  referenceId: z.string(),
  exact: z.string(),  // W3C Web Annotation standard
  position: z.object({
    offset: z.number(),
    length: z.number(),
  }),
  entityTypes: z.array(z.string()).optional(),
  targetDocumentId: z.string().optional(),
});

export const ReferenceResolvedPayloadSchema = z.object({
  referenceId: z.string(),
  targetDocumentId: z.string(),
});

export const ReferenceDeletedPayloadSchema = z.object({
  referenceId: z.string(),
});

// Entity tag event payloads
export const EntityTagAddedPayloadSchema = z.object({
  entityType: z.string(),
});

export const EntityTagRemovedPayloadSchema = z.object({
  entityType: z.string(),
});

// Union of all possible event payloads
export const EventPayloadSchema = z.union([
  DocumentCreatedPayloadSchema,
  DocumentClonedPayloadSchema,
  DocumentArchivedPayloadSchema,
  DocumentUnarchivedPayloadSchema,
  HighlightAddedPayloadSchema,
  HighlightRemovedPayloadSchema,
  ReferenceCreatedPayloadSchema,
  ReferenceResolvedPayloadSchema,
  ReferenceDeletedPayloadSchema,
  EntityTagAddedPayloadSchema,
  EntityTagRemovedPayloadSchema,
]);

// Event metadata schema
export const EventMetadataSchema = z.object({
  sequenceNumber: z.number(),
  streamPosition: z.number(),
  timestamp: z.string(),
  prevEventHash: z.string().optional(),
  checksum: z.string().optional(),
});

// Base event schema
export const BaseEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  documentId: z.string(),
  userId: z.string(),
  version: z.number(),
});

// Complete stored event schema
export const StoredEventSchema = z.object({
  event: z.object({
    id: z.string(),
    type: z.string(),
    timestamp: z.string(),
    userId: z.string(),
    documentId: z.string(),
    payload: EventPayloadSchema,
    version: z.number(),
  }),
  metadata: EventMetadataSchema,
  signature: z.object({
    algorithm: z.literal('ed25519'),
    publicKey: z.string(),
    signature: z.string(),
    keyId: z.string().optional(),
  }).optional(),
});

// Simplified schema for API responses (without nested structure)
export const StoredEventApiSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.string(),
  userId: z.string(),
  documentId: z.string(),
  payload: EventPayloadSchema,
  metadata: z.object({
    sequenceNumber: z.number(),
    prevEventHash: z.string().optional(),
    checksum: z.string().optional(),
  }),
});

// Event query filter schema
export const EventQuerySchema = z.object({
  documentId: z.string().optional(),
  userId: z.string().optional(),
  eventTypes: z.array(z.string()).optional(),
  fromTimestamp: z.string().optional(),
  toTimestamp: z.string().optional(),
  fromSequence: z.number().optional(),
  limit: z.number().optional(),
});

/**
 * Get Events Response
 */
export const GetEventsResponseSchema = z.object({
  events: z.array(z.object({
    event: z.object({
      id: z.string(),
      type: z.string(),
      timestamp: z.string(),
      userId: z.string(),
      documentId: z.string(),
      payload: z.any(),
    }),
    metadata: z.object({
      sequenceNumber: z.number(),
      prevEventHash: z.string().optional(),
      checksum: z.string().optional(),
    }),
  })),
  total: z.number(),
  documentId: z.string(),
});

export type GetEventsResponse = z.infer<typeof GetEventsResponseSchema>;
