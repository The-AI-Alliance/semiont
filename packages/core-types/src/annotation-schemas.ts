/**
 * Annotation Schema
 *
 * SINGLE SOURCE OF TRUTH for Annotation type definition.
 * All other annotation-related schemas derive from or reference this.
 */

import { z } from 'zod';
import { DocumentSchema } from './document-schemas';


/**
 * W3C Web Annotation Selector Types
 */
export const TextPositionSelectorSchema = z.object({
  type: z.literal("TextPositionSelector"),
  exact: z.string(),
  offset: z.number(),
  length: z.number(),
});

export const TextQuoteSelectorSchema = z.object({
  type: z.literal("TextQuoteSelector"),
  exact: z.string(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

export const SelectorSchema = z.union([
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
]);

export type TextPositionSelector = z.infer<typeof TextPositionSelectorSchema>;
export type TextQuoteSelector = z.infer<typeof TextQuoteSelectorSchema>;
export type Selector = z.infer<typeof SelectorSchema>;

/**
 * W3C Web Annotation Motivation Vocabulary
 * Full list from https://www.w3.org/TR/annotation-vocab/#motivation
 *
 * Note: We currently only use 'highlighting' and 'linking' in the application,
 * but the schema supports the full W3C vocabulary for future extensibility.
 */
export const MotivationSchema = z.enum([
  'assessing',      // Provide an assessment about the Target
  'bookmarking',    // Create a bookmark to the Target
  'classifying',    // Classify the Target as something
  'commenting',     // Comment about the Target
  'describing',     // Describe the Target
  'editing',        // Request a change or edit to the Target
  'highlighting',   // Highlight the Target resource or segment (currently used)
  'identifying',    // Assign an identity to the Target
  'linking',        // Link to a resource related to the Target (currently used)
  'moderating',     // Assign some value or quality to the Target
  'questioning',    // Ask a question about the Target
  'replying',       // Reply to a previous statement
  'tagging',        // Associate a tag with the Target
]);

export type Motivation = z.infer<typeof MotivationSchema>;

/**
 * W3C Web Annotation Agent Schema
 *
 * Represents an agent (person, software, or organization) that participates in annotation activities.
 * See https://www.w3.org/TR/annotation-model/#agents-and-attribution
 */
export const AgentSchema = z.object({
  id: z.string(),                                      // IRI identifying the agent
  type: z.enum(['Person', 'Organization', 'Software']), // Type of agent
  name: z.string(),                                    // Name of the agent
  nickname: z.string().optional(),                     // Optional nickname
  email: z.string().optional(),                        // Email (mailto: IRI)
  email_sha1: z.string().optional(),                   // SHA1 hash of email
  homepage: z.string().optional(),                     // Homepage URL
});

export type Agent = z.infer<typeof AgentSchema>;

/**
 * Annotation Schema
 *
 * Represents an annotation on a document, following W3C Web Annotation Data Model principles.
 *
 * Structure:
 * - id: Unique identifier for the annotation
 * - motivation: Why the annotation exists (W3C vocabulary - we currently use 'highlighting'/'linking')
 * - target: What is being annotated (document + text selector)
 *   - source: Document ID
 *   - selector: Single selector or array identifying the same text via different methods
 * - body: What we're saying about the annotated text
 *   - type: 'TextualBody' (textual content/comments) or 'SpecificResource' (links to another document)
 *   - value: Optional comment or note about the annotation (for TextualBody)
 *   - format: MIME type of the body value (e.g., 'text/plain', 'text/markdown')
 *   - language: ISO language code of the body value (e.g., 'en', 'fr')
 *   - source: Target document ID (for SpecificResource)
 *   - entityTypes: Classification tags (e.g., ["Person", "Scientist"])
 * - creator: Agent who created the annotation (string ID or rich Agent object)
 * - created: ISO 8601 timestamp
 * - resolvedBy: User who resolved a reference (optional)
 * - resolvedAt: When reference was resolved (optional)
 * - resolvedDocumentName: Display name of resolved document (optional)
 *
 * W3C Alignment:
 * - Separates target (what) from body (why/how) ✓
 * - Supports multiple selector types (TextPositionSelector, TextQuoteSelector) ✓
 * - Allows selector arrays for redundant identification ✓
 * - Uses full W3C 'motivation' vocabulary ✓
 * - Uses 'creator' and 'created' field names ✓
 * - Supports W3C Agent objects for creator (Person, Organization, Software) ✓
 * - Uses 'body.value' for textual content (W3C TextualBody pattern) ✓
 * - Uses 'body.format' for MIME type metadata ✓
 * - Uses 'body.language' for language metadata ✓
 * - Uses W3C body types: 'TextualBody' | 'SpecificResource' ✓
 * - Uses 'body.source' for linked resources (W3C SpecificResource pattern) ✓
 *
 * W3C Deviations (Intentional):
 * - Single target only (no multi-target arrays) - our architecture is document-centric
 * - Single body only (no multi-body arrays) - application-specific body structure
 * - Application-specific 'entityTypes' field for classification tags
 * - Creator accepts simple string for backward compatibility (but also supports rich Agent)
 */
export const AnnotationSchema = z.object({
  id: z.string(),
  motivation: MotivationSchema,
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
    format: z.string().optional(),      // MIME type (e.g., 'text/plain', 'text/html', 'text/markdown')
    language: z.string().optional(),    // ISO language code (e.g., 'en', 'fr', 'es')
    source: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).default([]),
  }),
  creator: z.union([z.string(), AgentSchema]),  // Simple string ID or rich Agent object
  created: z.string(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolvedDocumentName: z.string().optional(),
});

export type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * Highlight-specific annotation type
 */
export type HighlightAnnotation = Annotation & { body: { type: 'TextualBody' } };

/**
 * Reference-specific annotation type
 */
export type ReferenceAnnotation = Annotation & { body: { type: 'SpecificResource' } };

/**
 * Annotation update payload (all fields optional except what's being changed)
 */
export interface AnnotationUpdate {
  body?: {
    type?: 'TextualBody' | 'SpecificResource';
    value?: string | null;
    source?: string | null;
    entityTypes?: string[] | null;
  };
  resolvedDocumentName?: string | null;
}

/**
 * UI-level annotation categories derived from W3C types
 */
export type AnnotationCategory = 'highlight' | 'reference';

/**
 * Maps W3C body type to UI category
 */
export function getAnnotationCategory(annotation: Annotation): AnnotationCategory {
  return annotation.body.type === 'SpecificResource' ? 'reference' : 'highlight';
}

/**
 * Checks if annotation is a highlight
 */
export function isHighlight(annotation: Annotation): annotation is HighlightAnnotation {
  return annotation.body.type === 'TextualBody' && annotation.motivation === 'highlighting';
}

/**
 * Checks if annotation is a reference (stub or resolved)
 * Both stub and resolved references have:
 * - body.type === 'SpecificResource'
 * - motivation === 'linking'
 * Use isStubReference() or isResolvedReference() to distinguish between them
 */
export function isReference(annotation: Annotation): annotation is ReferenceAnnotation {
  return annotation.body.type === 'SpecificResource' && annotation.motivation === 'linking';
}

/**
 * Checks if annotation is a stub reference (reference without a resolved target document)
 * Stub references have body.source = null or undefined
 */
export function isStubReference(annotation: Annotation): boolean {
  return isReference(annotation) && !annotation.body.source;
}

/**
 * Checks if annotation is a resolved reference (reference with a target document)
 * Resolved references have body.source pointing to a document ID
 */
export function isResolvedReference(annotation: Annotation): annotation is ReferenceAnnotation {
  return isReference(annotation) && !!annotation.body.source;
}

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
 * Includes creator from the event's userId.
 */
export const CreateAnnotationInternalSchema = CreateAnnotationRequestSchema.extend({
  creator: z.string(),
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
