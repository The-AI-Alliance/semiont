/**
 * Pure logic extracted from CodeMirrorRenderer
 *
 * These functions have zero dependency on CodeMirror's DOM or React.
 * They handle position conversion, tooltip generation, and decoration metadata.
 */

import { ANNOTATORS } from './annotation-registry';
import { isHighlight, isReference, isResolvedReference, isComment, isAssessment, isTag, getBodySource } from '@semiont/api-client';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

export interface TextSegment {
  exact: string;
  annotation?: Annotation;
  start: number;
  end: number;
}

/**
 * Convert positions from CRLF character space to LF character space.
 * CodeMirror normalizes all line endings to LF internally, but annotation positions
 * are calculated in the original content's character space (which may have CRLF).
 *
 * @param segments - Segments with positions in CRLF space
 * @param content - Original content (may have CRLF line endings)
 * @returns Segments with positions adjusted for LF space
 */
export function convertSegmentPositions(segments: TextSegment[], content: string): TextSegment[] {
  // If content has no CRLF, no conversion needed
  if (!content.includes('\r\n')) {
    return segments;
  }

  // Build a map of CRLF positions for efficient lookup
  const crlfPositions: number[] = [];
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] === '\r' && content[i + 1] === '\n') {
      crlfPositions.push(i);
    }
  }

  // Binary search: count CRLFs before a position in O(log n)
  const convertPosition = (pos: number): number => {
    let lo = 0;
    let hi = crlfPositions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (crlfPositions[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return pos - lo;
  };

  return segments.map(seg => ({
    ...seg,
    start: convertPosition(seg.start),
    end: convertPosition(seg.end)
  }));
}

/**
 * Get tooltip text for annotation based on type/motivation
 */
export function getAnnotationTooltip(annotation: Annotation): string {
  const isCommentAnn = isComment(annotation);
  const isHighlightAnn = isHighlight(annotation);
  const isAssessmentAnn = isAssessment(annotation);
  const isTagAnn = isTag(annotation);
  const isReferenceAnn = isReference(annotation);
  const isResolvedRef = isResolvedReference(annotation);

  if (isCommentAnn) {
    return 'Comment';
  } else if (isHighlightAnn) {
    return 'Highlight';
  } else if (isAssessmentAnn) {
    return 'Assessment';
  } else if (isTagAnn) {
    return 'Tag';
  } else if (isResolvedRef) {
    return 'Resolved Reference';
  } else if (isReferenceAnn) {
    return 'Unresolved Reference';
  }
  return 'Annotation';
}

/**
 * Metadata for a single annotation decoration (class name, data attributes, tooltip)
 */
export interface AnnotationDecorationMeta {
  className: string;
  annotationType: string;
  annotationId: string;
  tooltip: string;
}

/**
 * Compute decoration metadata for a single annotated segment.
 * Pure function — no CodeMirror dependency.
 */
export function getAnnotationDecorationMeta(
  annotation: Annotation,
  isNew: boolean
): AnnotationDecorationMeta {
  const baseClassName = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(annotation))?.className || 'annotation-highlight';
  const className = isNew ? `${baseClassName} annotation-sparkle` : baseClassName;

  const isHighlightAnn = isHighlight(annotation);
  const isReferenceAnn = isReference(annotation);
  const isCommentAnn = isComment(annotation);
  const isAssessmentAnn = isAssessment(annotation);
  const isTagAnn = isTag(annotation);

  let annotationType = 'highlight';
  if (isCommentAnn) annotationType = 'comment';
  else if (isReferenceAnn) annotationType = 'reference';
  else if (isAssessmentAnn) annotationType = 'assessment';
  else if (isTagAnn) annotationType = 'tag';
  else if (isHighlightAnn) annotationType = 'highlight';

  return {
    className,
    annotationType,
    annotationId: annotation.id,
    tooltip: getAnnotationTooltip(annotation),
  };
}

/**
 * Compute all annotation decoration metadata from segments.
 * Returns sorted, filtered entries ready for CodeMirror's RangeSetBuilder.
 */
export function computeAnnotationDecorations(
  segments: TextSegment[],
  newAnnotationIds?: Set<string>
): Array<{ start: number; end: number; meta: AnnotationDecorationMeta }> {
  return segments
    .filter(s => s.annotation)
    .sort((a, b) => a.start - b.start)
    .map(segment => {
      const annotation = segment.annotation!;
      const isNew = newAnnotationIds?.has(annotation.id) || false;
      return {
        start: segment.start,
        end: segment.end,
        meta: getAnnotationDecorationMeta(annotation, isNew),
      };
    });
}

/**
 * Widget metadata for a reference annotation
 */
export interface ReferenceWidgetMeta {
  annotationId: string;
  position: number;
  targetName: string | undefined;
  isGenerating: boolean;
  bodySource: string | undefined;
}

/**
 * Compute widget metadata for reference annotations.
 * Pure function — no CodeMirror dependency.
 */
export function computeWidgetDecorations(
  segments: TextSegment[],
  generatingReferenceId: string | null | undefined,
  getTargetDocumentName?: (documentId: string) => string | undefined
): ReferenceWidgetMeta[] {
  return segments
    .filter(s => s.annotation && isReference(s.annotation))
    .sort((a, b) => a.end - b.end)
    .map(segment => {
      const annotation = segment.annotation!;
      const bodySource = getBodySource(annotation.body);
      const targetName = bodySource ? getTargetDocumentName?.(bodySource) : undefined;
      const isGenerating = generatingReferenceId ? annotation.id === generatingReferenceId : false;

      return {
        annotationId: annotation.id,
        position: segment.end,
        targetName,
        isGenerating,
        bodySource: bodySource ?? undefined,
      };
    });
}
