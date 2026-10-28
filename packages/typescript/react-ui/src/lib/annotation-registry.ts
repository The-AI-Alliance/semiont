/**
 * Centralized annotation type registry
 *
 * Single source of truth for W3C annotation motivation metadata including:
 * - Visual styling (CSS class, icon)
 * - Type guards (motivation matching)
 * - Accessibility (screen reader announcements)
 *
 * This is the ONLY place to define annotation type metadata: one decision
 * lives in one place. No aliasing, wrappers, or compatibility layers elsewhere.
 */

import type { components } from '@semiont/core';
import { isHighlight, isComment, isReference, isTag } from '@semiont/core';
import type { Annotation } from '@semiont/core';
type Motivation = components['schemas']['Motivation'];

/**
 * Annotator: the metadata of one annotation type - how its annotations are
 * recognized, displayed and announced
 */
export interface Annotator {
  // Metadata (static)
  motivation: Motivation;
  internalType: string;
  displayName: string;

  // Visual styling
  className: string;
  iconEmoji?: string;

  // Type guard function
  matchesAnnotation: (annotation: Annotation) => boolean;

  // Accessibility
  announceOnCreate: string;
}

/**
 * Static annotator definitions - single source of truth
 */
export const ANNOTATORS = {
  highlight: {
    motivation: 'highlighting',
    internalType: 'highlight',
    displayName: 'Highlight',
    className: 'annotation-highlight',
    iconEmoji: '🟡',
    matchesAnnotation: (ann: Annotation) => isHighlight(ann),
    announceOnCreate: 'Highlight created'
  },
  comment: {
    motivation: 'commenting',
    internalType: 'comment',
    displayName: 'Comment',
    className: 'annotation-comment',
    iconEmoji: '💬',
    matchesAnnotation: (ann: Annotation) => isComment(ann),
    announceOnCreate: 'Comment created'
  },
  assessment: {
    motivation: 'assessing',
    internalType: 'assessment',
    displayName: 'Assessment',
    className: 'annotation-assessment',
    iconEmoji: '🔴',
    matchesAnnotation: (ann: Annotation) => ann.motivation === 'assessing',
    announceOnCreate: 'Assessment created'
  },
  reference: {
    motivation: 'linking',
    internalType: 'reference',
    displayName: 'Reference',
    className: 'annotation-reference',
    iconEmoji: '🔵',
    matchesAnnotation: (ann: Annotation) => isReference(ann),
    announceOnCreate: 'Reference created'
  },
  tag: {
    motivation: 'tagging',
    internalType: 'tag',
    displayName: 'Tag',
    className: 'annotation-tag',
    iconEmoji: '🏷️',
    matchesAnnotation: (ann: Annotation) => isTag(ann),
    announceOnCreate: 'Tag created'
  }
} satisfies Record<string, Annotator>;

/** Keys of the annotator registry — also the annotations panel's tab keys. */
export type AnnotatorKey = keyof typeof ANNOTATORS;

/**
 * Annotator key (= panel tab key) for a motivation — derived from
 * {@link ANNOTATORS}, the single motivation↔annotator source, so no second
 * hand-written map can drift. Takes `string`, not `Motivation`: the schemas
 * type motivation properly (`BrowsePanelOpenEvent.motivation` is a `Motivation`
 * `$ref`), but `panel:open` is not wire-validated at runtime, so loose strings
 * can still arrive — callers at that boundary must handle `undefined`.
 */
export function annotatorKeyForMotivation(motivation: string): AnnotatorKey | undefined {
  const entry = (Object.entries(ANNOTATORS) as [AnnotatorKey, Annotator][])
    .find(([, annotator]) => annotator.motivation === motivation);
  return entry?.[0];
}

