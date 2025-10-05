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
 * This is the SINGLE SOURCE OF TRUTH for annotation types.
 *
 * Field Requirements:
 * - text: REQUIRED (not optional)
 * - type: REQUIRED (not optional)
 * - referencedDocumentId: OPTIONAL and nullable
 * - entityTypes: REQUIRED (always present, defaults to empty array)
 * - referenceType: OPTIONAL
 */
const AnnotationSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  text: z.string(),                                    // REQUIRED
  selectionData: z.object({
    type: z.string(),
    offset: z.number(),
    length: z.number(),
    text: z.string(),
  }),
  type: z.enum(['highlight', 'reference']),            // REQUIRED
  referencedDocumentId: z.string().nullable().optional(), // OPTIONAL, nullable
  entityTypes: z.array(z.string()).default([]),        // REQUIRED (defaults to [])
  referenceType: z.string().optional(),                // OPTIONAL
});

export type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * Highlight-specific annotation type
 */
export type HighlightAnnotation = Annotation & { type: 'highlight' };

/**
 * Reference-specific annotation type
 */
export type ReferenceAnnotation = Annotation & { type: 'reference' };

/**
 * Annotation update payload (all fields optional except what's being changed)
 */
export interface AnnotationUpdate {
  type?: 'highlight' | 'reference';
  entityTypes?: string[] | null;
  referenceType?: string | null;
  referencedDocumentId?: string | null;
}

/**
 * Text selection (position in document)
 */
export interface TextSelection {
  text: string;
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
