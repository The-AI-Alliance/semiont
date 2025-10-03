/**
 * API Contract Schemas
 *
 * Pure Zod schemas defining REST API contracts.
 * Backend uses these for validation, frontend for type inference.
 *
 * NOTE: This file uses ONLY plain Zod - no @hono/zod-openapi
 * to avoid memory issues during typecheck.
 */

import { z } from 'zod';

/**
 * Create Selection Request
 *
 * Backend API format for creating a selection (highlight or reference)
 */
export const CreateSelectionRequestSchema = z.object({
  documentId: z.string(),
  selectionType: z.union([
    z.enum(['highlight', 'reference']),
    z.object({
      type: z.string(),
      offset: z.number(),
      length: z.number(),
      text: z.string()
    })
  ]),
  selectionData: z.record(z.string(), z.any()).optional(),
  entityTypes: z.array(z.string()).optional(),
  referenceTags: z.array(z.string()).optional(),
  resolvedDocumentId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type CreateSelectionRequest = z.infer<typeof CreateSelectionRequestSchema>;

/**
 * Create Selection Response
 */
export const CreateSelectionResponseSchema = z.object({
  selection: z.object({
    id: z.string(),
    documentId: z.string(),
    selectionType: z.string(),
    selectionData: z.any(),
    resolvedDocumentId: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).optional(),
    referenceTags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
});

export type CreateSelectionResponse = z.infer<typeof CreateSelectionResponseSchema>;

/**
 * Annotation format returned by highlights/references endpoints
 *
 * This is the standardized format that frontend components expect
 */
const AnnotationSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  text: z.string(),
  selectionData: z.object({
    type: z.string(),
    offset: z.number(),
    length: z.number(),
    text: z.string(),
  }),
  type: z.enum(['highlight', 'reference']),
  referencedDocumentId: z.string().optional(),
  entityTypes: z.array(z.string()).optional(),
  referenceType: z.string().optional(),
});

export type Annotation = z.infer<typeof AnnotationSchema>;

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
