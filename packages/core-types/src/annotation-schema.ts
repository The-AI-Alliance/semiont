/**
 * Annotation Schema
 *
 * SINGLE SOURCE OF TRUTH for Annotation type definition.
 * All other annotation-related schemas derive from or reference this.
 */

import { z } from 'zod';

/**
 * Annotation format returned by highlights/references endpoints
 *
 * W3C Web Annotation Data Model alignment:
 * - target: what's being annotated (document + selector)
 * - body: what we're saying about it (type, entities, reference info)
 *
 * Field Requirements:
 * - target.selector.exact: REQUIRED - exact text content (W3C Web Annotation standard)
 * - body.type: REQUIRED (not optional)
 * - createdBy: REQUIRED (user who created)
 * - body.referencedDocumentId: OPTIONAL and nullable
 * - body.entityTypes: REQUIRED (always present, defaults to empty array)
 * - body.referenceType: OPTIONAL
 * - resolvedBy: OPTIONAL (user who resolved reference)
 * - resolvedAt: OPTIONAL (when reference was resolved)
 */
export const AnnotationSchema = z.object({
  id: z.string(),
  target: z.object({
    source: z.string(),  // Document ID
    selector: z.object({
      type: z.literal("TextPositionSelector"),
      exact: z.string(),
      offset: z.number(),
      length: z.number(),
    }),
  }),
  body: z.object({
    type: z.enum(['highlight', 'reference']),
    entityTypes: z.array(z.string()).default([]),
    referenceType: z.string().optional(),
    referencedDocumentId: z.string().nullable().optional(),
  }),
  createdBy: z.string(),
  createdAt: z.string(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolvedDocumentName: z.string().optional(),
});

export type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * Highlight-specific annotation type
 */
export type HighlightAnnotation = Annotation & { body: { type: 'highlight' } };

/**
 * Reference-specific annotation type
 */
export type ReferenceAnnotation = Annotation & { body: { type: 'reference' } };

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
