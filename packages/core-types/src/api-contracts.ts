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
 * Create Annotation API Request
 *
 * Frontend-to-backend API format for creating an annotation.
 * createdBy is derived from authenticated user on backend.
 */
export const CreateAnnotationRequestSchema = z.object({
  documentId: z.string(),
  text: z.string(),
  selectionData: z.object({
    type: z.string(),
    offset: z.number(),
    length: z.number(),
  }),
  type: z.enum(['highlight', 'reference']),
  entityTypes: z.array(z.string()).optional(),
  referenceType: z.string().optional(),
  referencedDocumentId: z.string().nullable().optional(),
});

export type CreateAnnotationRequest = z.infer<typeof CreateAnnotationRequestSchema>;

/**
 * Create Annotation Internal Input
 *
 * Backend internal format used by graph implementations when consuming events.
 * Includes createdBy from the event's userId.
 */
export const CreateAnnotationInternalSchema = CreateAnnotationRequestSchema.extend({
  createdBy: z.string(),
});

export type CreateAnnotationInternal = z.infer<typeof CreateAnnotationInternalSchema>;

/**
 * Create Annotation Response
 */
export const CreateAnnotationResponseSchema = z.object({
  annotation: z.object({
    id: z.string(),
    documentId: z.string(),
    text: z.string(),
    selectionData: z.object({
      type: z.string(),
      offset: z.number(),
      length: z.number(),
    }),
    type: z.enum(['highlight', 'reference']),
    referencedDocumentId: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).optional(),
    referenceType: z.string().optional(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
});

export type CreateAnnotationResponse = z.infer<typeof CreateAnnotationResponseSchema>;

/**
 * Annotation format returned by highlights/references endpoints
 *
 * This is the SINGLE SOURCE OF TRUTH for annotation types.
 *
 * Field Requirements:
 * - text: REQUIRED (not optional)
 * - type: REQUIRED (not optional)
 * - createdBy: REQUIRED (user who created)
 * - referencedDocumentId: OPTIONAL and nullable
 * - entityTypes: REQUIRED (always present, defaults to empty array)
 * - referenceType: OPTIONAL
 * - resolvedBy: OPTIONAL (user who resolved reference)
 * - resolvedAt: OPTIONAL (when reference was resolved)
 */
const AnnotationSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  text: z.string(),                                    // REQUIRED - full selected text
  selectionData: z.object({
    type: z.string(),
    offset: z.number(),
    length: z.number(),
  }),
  type: z.enum(['highlight', 'reference']),            // REQUIRED
  createdBy: z.string(),                               // REQUIRED
  createdAt: z.string(),                               // REQUIRED - ISO 8601 string (JSON serialized)
  referencedDocumentId: z.string().nullable().optional(), // OPTIONAL, nullable
  resolvedDocumentName: z.string().optional(),         // OPTIONAL (name of referenced document)
  entityTypes: z.array(z.string()).default([]),        // REQUIRED (defaults to [])
  referenceType: z.string().optional(),                // OPTIONAL
  resolvedBy: z.string().optional(),                   // OPTIONAL (who resolved the reference)
  resolvedAt: z.string().optional(),                   // OPTIONAL (when resolved) - ISO 8601 string
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
  resolvedDocumentName?: string | null;
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
