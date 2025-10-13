/**
 * Annotation API Request/Response Schemas
 *
 * API contracts for annotation-related endpoints.
 * Core annotation schema is in ./annotation-schema.ts
 */

import { z } from 'zod';
import { AnnotationSchema, SelectorSchema, AgentSchema } from './annotation-schema';
import { DocumentSchema } from './document';

// Re-export core annotation types for convenience
export {
  AnnotationSchema,
  SelectorSchema,
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
  MotivationSchema,
  AgentSchema,
  getAnnotationCategory,
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
  extractAnnotationId,
  compareAnnotationIds,
  isFullAnnotationUri,
  getAnnotationApiId,
  encodeAnnotationIdForUrl,
} from './annotation-schema';
export type {
  Annotation,
  HighlightAnnotation,
  ReferenceAnnotation,
  AnnotationUpdate,
  AnnotationCategory,
  Motivation,
  Agent,
  TextPositionSelector,
  TextQuoteSelector,
  Selector,
} from './annotation-schema';

/**
 * Create Annotation API Request
 *
 * Frontend-to-backend API format for creating an annotation.
 * creator is derived from authenticated user on backend.
 *
 * Phase 2: Multi-Selector Support
 * - selector can be single selector or array of selectors
 * - Multiple selectors identify the same text using different methods
 */
export const CreateAnnotationRequestSchema = z.object({
  motivation: z.enum([
    'assessing', 'bookmarking', 'classifying', 'commenting', 'describing',
    'editing', 'highlighting', 'identifying', 'linking', 'moderating',
    'questioning', 'replying', 'tagging'
  ]).optional(),  // W3C motivation - defaults to 'highlighting' or 'linking' based on body type
  target: z.object({
    source: z.string(),
    selector: z.union([
      SelectorSchema,
      z.array(SelectorSchema),
    ]),
  }),
  body: z.object({
    type: z.enum(['TextualBody', 'SpecificResource']),
    value: z.string().optional(),
    source: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).optional(),
  }),
});

export type CreateAnnotationRequest = z.infer<typeof CreateAnnotationRequestSchema>;

/**
 * Create Annotation Internal Input
 *
 * Backend internal format used by graph implementations when consuming events.
 * Includes creator Agent object with DID:WEB identifier.
 */
export const CreateAnnotationInternalSchema = CreateAnnotationRequestSchema.extend({
  id: z.string(),  // Required: ID comes from event payload (generated upstream in Layer 2)
  creator: AgentSchema,
});

export type CreateAnnotationInternal = z.infer<typeof CreateAnnotationInternalSchema>;

/**
 * Create Annotation Response
 */
export const CreateAnnotationResponseSchema = z.object({
  annotation: AnnotationSchema,
});

export type CreateAnnotationResponse = z.infer<typeof CreateAnnotationResponseSchema>;


/**
 * Text selection (position in document)
 */
export interface TextSelection {
  exact: string;  // W3C Web Annotation standard
  start: number;
  end: number;
}

/**
 * Get Highlights Response
 */
export const GetHighlightsResponseSchema = z.object({
  highlights: z.array(AnnotationSchema),
});

export type GetHighlightsResponse = z.infer<typeof GetHighlightsResponseSchema>;

/**
 * Get References Response
 */
export const GetReferencesResponseSchema = z.object({
  references: z.array(AnnotationSchema),
});

export type GetReferencesResponse = z.infer<typeof GetReferencesResponseSchema>;

/**
 * Get All Annotations Response (both highlights and references)
 */
export const GetAnnotationsResponseSchema = z.object({
  annotations: z.array(AnnotationSchema),
});

export type GetAnnotationsResponse = z.infer<typeof GetAnnotationsResponseSchema>;

/**
 * Delete Annotation Request
 */
export const DeleteAnnotationRequestSchema = z.object({
  documentId: z.string().describe('Document ID containing the annotation (required for O(1) Layer 3 lookup)'),
});

export type DeleteAnnotationRequest = z.infer<typeof DeleteAnnotationRequestSchema>;

/**
 * Delete Annotation Response
 */
export const DeleteAnnotationResponseSchema = z.object({
  success: z.boolean(),
});

export type DeleteAnnotationResponse = z.infer<typeof DeleteAnnotationResponseSchema>;

/**
 * Referenced By - Documents that reference a specific document
 */
export const ReferencedBySchema = z.object({
  id: z.string().describe('Reference annotation ID'),
  documentName: z.string().describe('Name of document containing the reference'),
  target: z.object({
    source: z.string().describe('ID of document containing the reference'),
    selector: z.object({
      exact: z.string().describe('The selected text that references this document'),
    }),
  }),
});

export type ReferencedBy = z.infer<typeof ReferencedBySchema>;

/**
 * Get Referenced By Response
 */
export const GetReferencedByResponseSchema = z.object({
  referencedBy: z.array(ReferencedBySchema),
});

export type GetReferencedByResponse = z.infer<typeof GetReferencedByResponseSchema>;

/**
 * Resolve Annotation Request
 */
export const ResolveAnnotationRequestSchema = z.object({
  documentId: z.string().describe('Target document ID to resolve reference to'),
});

export type ResolveAnnotationRequest = z.infer<typeof ResolveAnnotationRequestSchema>;

/**
 * Resolve Annotation Response
 */
export const ResolveAnnotationResponseSchema = z.object({
  annotation: AnnotationSchema,
  targetDocument: DocumentSchema.nullable(),
});

export type ResolveAnnotationResponse = z.infer<typeof ResolveAnnotationResponseSchema>;

/**
 * Detect Annotations Response
 */
export const DetectAnnotationsResponseSchema = z.object({
  annotations: z.array(z.object({
    id: z.string(),
    documentId: z.string(),
    selector: z.union([SelectorSchema, z.array(SelectorSchema)]),
    source: z.string().nullable(),
    entityTypes: z.array(z.string()),
    created: z.string(),
  })),
  detected: z.number(),
});

export type DetectAnnotationsResponse = z.infer<typeof DetectAnnotationsResponseSchema>;


/**
 * Reference LLM Context Response
 */
export const ReferenceLLMContextResponseSchema = z.object({
  reference: AnnotationSchema,
  sourceDocument: DocumentSchema,
  targetDocument: DocumentSchema.nullable(),
  sourceContext: z.object({
    before: z.string(),
    selected: z.string(),
    after: z.string(),
  }).optional(),
  targetContext: z.object({
    content: z.string(),
    summary: z.string().optional(),
  }).optional(),
  suggestedResolution: z.object({
    documentId: z.string(),
    documentName: z.string(),
    confidence: z.number(),
    reasoning: z.string(),
  }).optional(),
});

export type ReferenceLLMContextResponse = z.infer<typeof ReferenceLLMContextResponseSchema>;

/**
 * Get Annotation Response
 */
export const GetAnnotationResponseSchema = z.object({
  annotation: AnnotationSchema,
  document: DocumentSchema.nullable(),
  resolvedDocument: DocumentSchema.nullable(),
});

export type GetAnnotationResponse = z.infer<typeof GetAnnotationResponseSchema>;

/**
 * List Annotations Response
 */
export const ListAnnotationsResponseSchema = z.object({
  annotations: z.array(AnnotationSchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});

export type ListAnnotationsResponse = z.infer<typeof ListAnnotationsResponseSchema>;

/**
 * Annotation Context Response
 */
export const AnnotationContextResponseSchema = z.object({
  annotation: z.object({
    id: z.string(),
    documentId: z.string(),
    selector: z.object({
      exact: z.string(),
      offset: z.number(),
      length: z.number(),
    }),
    referencedDocumentId: z.string().nullable(),
    entityTypes: z.array(z.string()),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
  document: DocumentSchema,
});

export type AnnotationContextResponse = z.infer<typeof AnnotationContextResponseSchema>;
