/**
 * Base Entity Schemas
 *
 * Core Document and Annotation schemas that are used by both
 * document-schemas and annotation-schemas. This file exists to break
 * the circular dependency between those two modules.
 */

import { z } from 'zod';
import { CREATION_METHODS } from './creation-methods';

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
 * Content Format Schema
 *
 * Supported MIME types for document and annotation content.
 */
export const ContentFormatSchema = z.enum([
  'text/plain',
  'text/markdown',
]);

// Note: ContentFormat type is exported from @semiont/api-client via index.ts
// export type ContentFormat = z.infer<typeof ContentFormatSchema>;

/**
 * Document Schema
 *
 * Core document model used across the application.
 */
export const DocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: ContentFormatSchema, // MIME type
  archived: z.boolean(),
  entityTypes: z.array(z.string()),
  locale: z.string().optional(), // Language/locale code (e.g., 'en', 'es', 'fr')
  creationMethod: z.enum([
    CREATION_METHODS.API,
    CREATION_METHODS.UPLOAD,
    CREATION_METHODS.UI,
    CREATION_METHODS.REFERENCE,
    CREATION_METHODS.CLONE,
    CREATION_METHODS.GENERATED,
  ] as const),
  sourceAnnotationId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
  creator: z.string(),
  created: z.string(),
  contentChecksum: z.string(),
});

// Note: Document type is exported from @semiont/api-client via index.ts
// export type Document = z.infer<typeof DocumentSchema>;

/**
 * Annotation Schema
 *
 * Core annotation model following W3C Web Annotation Data Model.
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
    format: ContentFormatSchema.optional(),      // MIME type
    language: z.string().optional(),    // ISO language code (e.g., 'en', 'fr', 'es')
    source: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).default([]),
  }),
  creator: AgentSchema,                          // W3C: Agent who created (always Agent object with DID:WEB)
  created: z.string(),
  modified: z.string().optional(),               // W3C: Timestamp of last modification
  generator: AgentSchema.optional(),             // W3C: Agent who last modified
});

// Note: Annotation type is exported from @semiont/api-client via index.ts
// export type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * Highlight-specific annotation type
 * Note: These derived types are defined in annotation-schemas.ts using OpenAPI Annotation type
 */
// export type HighlightAnnotation = Annotation & { body: { type: 'TextualBody' } };

/**
 * Reference-specific annotation type
 * Note: These derived types are defined in annotation-schemas.ts using OpenAPI Annotation type
 */
// export type ReferenceAnnotation = Annotation & { body: { type: 'SpecificResource' } };
