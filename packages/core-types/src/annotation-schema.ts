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
 * - modified: ISO 8601 timestamp of last modification (optional, W3C standard)
 * - generator: Agent who last modified the annotation (optional, W3C standard)
 *
 * W3C Alignment:
 * - Separates target (what) from body (why/how) ✓
 * - Supports multiple selector types (TextPositionSelector, TextQuoteSelector) ✓
 * - Allows selector arrays for redundant identification ✓
 * - Uses full W3C 'motivation' vocabulary ✓
 * - Uses 'creator' and 'created' field names ✓
 * - Uses 'modified' and 'generator' for modification tracking ✓
 * - Supports W3C Agent objects for creator/generator (Person, Organization, Software) ✓
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
 *
 * EXAMPLES:
 *
 * 1. Highlight (TextualBody with motivation 'highlighting'):
 * {
 *   id: "urn:uuid:abc123",
 *   motivation: "highlighting",
 *   target: {
 *     source: "doc-abc123",
 *     selector: {
 *       type: "TextPositionSelector",
 *       exact: "important text to highlight",
 *       offset: 100,
 *       length: 26
 *     }
 *   },
 *   body: {
 *     type: "TextualBody",
 *     value: undefined,  // highlights don't have comments
 *     source: null,
 *     entityTypes: []
 *   },
 *   creator: { id: "did:web:example.com:users:alice", type: "Person", name: "Alice" },
 *   created: "2025-01-10T10:00:00Z"
 * }
 *
 * 2. Stub Reference (SpecificResource with source=null, motivation 'linking'):
 * {
 *   id: "urn:uuid:def456",
 *   motivation: "linking",
 *   target: {
 *     source: "doc-abc123",
 *     selector: {
 *       type: "TextPositionSelector",
 *       exact: "Einstein's theory",
 *       offset: 200,
 *       length: 17
 *     }
 *   },
 *   body: {
 *     type: "SpecificResource",
 *     source: null,  // NULL = unresolved stub reference
 *     entityTypes: ["Person", "Scientist"]
 *   },
 *   creator: { id: "did:web:example.com:users:alice", type: "Person", name: "Alice" },
 *   created: "2025-01-10T10:05:00Z"
 * }
 *
 * 3. Resolved Reference (SpecificResource with source set, motivation 'linking'):
 * {
 *   id: "urn:uuid:def456",  // Same ID as stub, updated in place
 *   motivation: "linking",
 *   target: {
 *     source: "doc-abc123",
 *     selector: {
 *       type: "TextPositionSelector",
 *       exact: "Einstein's theory",
 *       offset: 200,
 *       length: 17
 *     }
 *   },
 *   body: {
 *     type: "SpecificResource",
 *     source: "doc-xyz789",  // Now links to target document
 *     entityTypes: ["Person", "Scientist"]
 *   },
 *   creator: { id: "did:web:example.com:users:alice", type: "Person", name: "Alice" },
 *   created: "2025-01-10T10:05:00Z",
 *   modified: "2025-01-10T10:10:00Z",  // Updated when resolved
 *   generator: { id: "did:web:example.com:ai:assistant", type: "Software", name: "AI Assistant" }
 * }
 *
 * KEY INSIGHT: The text being annotated is in target.selector.exact
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
  creator: AgentSchema,                          // W3C: Agent who created (always Agent object with DID:WEB)
  created: z.string(),
  modified: z.string().optional(),               // W3C: Timestamp of last modification
  generator: AgentSchema.optional(),             // W3C: Agent who last modified
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
