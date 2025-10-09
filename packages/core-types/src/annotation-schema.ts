/**
 * Annotation Schema
 *
 * SINGLE SOURCE OF TRUTH for Annotation type definition.
 * All other annotation-related schemas derive from or reference this.
 */

import { z } from 'zod';

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
 * Annotation format returned by highlights/references endpoints
 *
 * W3C Web Annotation Data Model alignment:
 * - target: what's being annotated (document + selector/selectors)
 * - body: what we're saying about it (type, entities, reference info)
 *
 * Phase 2: Multi-Selector Support
 * - target.selector: can be single selector or array of selectors
 * - Multiple selectors identify the same text using different methods
 * - First selector is preferred, others are fallbacks
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
    selector: z.union([
      SelectorSchema,
      z.array(SelectorSchema),
    ]),
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
  body?: {
    type?: 'highlight' | 'reference';
    entityTypes?: string[] | null;
    referenceType?: string | null;
    referencedDocumentId?: string | null;
  };
  resolvedDocumentName?: string | null;
}
