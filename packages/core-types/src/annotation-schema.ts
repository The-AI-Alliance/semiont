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
 *   - source: Target document ID (for SpecificResource)
 *   - entityTypes: Classification tags (e.g., ["Person", "Scientist"])
 * - creator: User who created the annotation
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
 * - Uses 'body.value' for textual content (W3C TextualBody pattern) ✓
 * - Uses W3C body types: 'TextualBody' | 'SpecificResource' ✓
 * - Uses 'body.source' for linked resources (W3C SpecificResource pattern) ✓
 *
 * W3C Deviations (Intentional):
 * - Single target only (no multi-target arrays) - our architecture is document-centric
 * - Single body only (no multi-body arrays) - application-specific body structure
 * - Application-specific 'entityTypes' field for classification tags
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
    source: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).default([]),
  }),
  creator: z.string(),
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
 * Checks if annotation is a reference
 */
export function isReference(annotation: Annotation): annotation is ReferenceAnnotation {
  return annotation.body.type === 'SpecificResource' && annotation.motivation === 'linking';
}
