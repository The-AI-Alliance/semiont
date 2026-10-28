/**
 * Pure logic for CodeMirrorRenderer
 *
 * These functions have zero dependency on CodeMirror's DOM or React.
 * They handle the conversion between the content's offsets and the
 * document's positions, tooltip generation, and decoration metadata.
 */

import { ANNOTATORS } from './annotation-registry';
import { isHighlight, isReference, isResolvedReference, isComment, isAssessment, isTag, getBodySource } from '@semiont/core';
import type { Annotation, AnchorStrategy, AnchorConfidence, TextOffsets } from '@semiont/core';

export interface TextSegment {
  exact: string;
  annotation?: Annotation;
  /**
   * Where the segment starts and where it ends. From
   * `segmentTextWithAnnotations` these are offsets into the content, in
   * Unicode code points; `convertSegmentPositions` answers the same segments
   * with positions in CodeMirror's document, which is what the decorations
   * are built from.
   */
  start: number;
  end: number;
  /** How `segmentTextWithAnnotations` resolved the anchor. Present only on
   *  annotated segments — background text has no strategy. */
  strategy?: AnchorStrategy;
  /** Confidence of the anchor classification. `'high'` is the no-ambiguity
   *  path; `'medium'` / `'low'` warrant the visual affordance and a one-
   *  shot warning log. */
  confidence?: AnchorConfidence;
}

/**
 * Where an offset into the content meets a position in CodeMirror's document.
 *
 * An offset counts the content's Unicode code points, exactly as decoded: a
 * CRLF is two. CodeMirror indexes its document in UTF-16 code units, where a
 * character outside the Basic Multilingual Plane is two, and holds every line
 * break as one unit, whatever the content ends its lines with. So a position
 * is past its offset by each such character before it, and short of it by
 * each CRLF before it.
 */
export interface DocumentPositions {
  /** The position in CodeMirror's document of an offset into the content. */
  positionAt(offset: number): number;
  /** The offset into the content of a position in CodeMirror's document. */
  offsetAt(position: number): number;
}

/** How many of `sorted` are less than `value`. */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The conversions for one content, made once and asked as often as the
 * content has annotations and selections. `offsets` is the content's own
 * (`textOffsets(content)`).
 *
 * An offset between the CR and the LF of a CRLF is before that line break in
 * the document, as the CR is. A position in the document is never between
 * them: before the line break it is the CR's offset, after it the offset past
 * the LF.
 */
export function documentPositions(content: string, offsets: TextOffsets): DocumentPositions {
  /** The index in the content of each CRLF: of its CR. */
  const crlfs: number[] = [];
  for (let index = content.indexOf('\r\n'); index !== -1; index = content.indexOf('\r\n', index + 2)) {
    crlfs.push(index);
  }
  /** The position in the document of each of those line breaks: its index, less the CRLFs before it. */
  const lineBreaks = crlfs.map((index, before) => index - before);

  return {
    positionAt(offset: number): number {
      const index = offsets.indexAt(offset);
      return index - countBelow(crlfs, index);
    },
    offsetAt(position: number): number {
      return offsets.offsetAt(position + countBelow(lineBreaks, position));
    },
  };
}

/**
 * The same segments, placed in CodeMirror's document: each one's two offsets
 * into the content as the positions the document has them at.
 */
export function convertSegmentPositions(segments: TextSegment[], positions: DocumentPositions): TextSegment[] {
  return segments.map(seg => ({
    ...seg,
    start: positions.positionAt(seg.start),
    end: positions.positionAt(seg.end),
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
  /** Carries through from the segment's anchor classification so the
   *  rendered DOM can surface a low-confidence affordance. */
  strategy?: AnchorStrategy;
  confidence?: AnchorConfidence;
}

/**
 * Compute decoration metadata for a single annotated segment.
 * Pure function — no CodeMirror dependency.
 */
export function getAnnotationDecorationMeta(
  annotation: Annotation,
  isNew: boolean,
  segment?: { strategy?: AnchorStrategy; confidence?: AnchorConfidence }
): AnnotationDecorationMeta {
  const baseClassName = Object.values(ANNOTATORS).find(a => a.matchesAnnotation(annotation))?.className || 'annotation-highlight';
  // Mark low-confidence anchors with an extra class so CSS can render the
  // dotted-underline / translucent affordance.
  const lowConfidenceClass =
    segment?.confidence && segment.confidence !== 'high' ? ' annotation-low-confidence' : '';
  const className = `${baseClassName}${isNew ? ' annotation-sparkle' : ''}${lowConfidenceClass}`;

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

  const baseTooltip = getAnnotationTooltip(annotation);
  // When the anchor is degraded, the tooltip names the strategy so an
  // operator hovering can see why the highlight has the warning style.
  const tooltip =
    segment?.strategy && segment.strategy !== 'fast-path' && segment.strategy !== 'unique-occurrence'
      ? `${baseTooltip} (anchored: ${segment.strategy})`
      : baseTooltip;

  return {
    className,
    annotationType,
    annotationId: annotation.id,
    tooltip,
    ...(segment?.strategy !== undefined ? { strategy: segment.strategy } : {}),
    ...(segment?.confidence !== undefined ? { confidence: segment.confidence } : {}),
  };
}

/**
 * Compute all annotation decoration metadata from segments.
 * Returns sorted, filtered entries ready for CodeMirror's RangeSetBuilder.
 */
export function computeAnnotationDecorations(
  segments: TextSegment[],
  sparkleAnnotationIds?: Set<string>
): Array<{ start: number; end: number; meta: AnnotationDecorationMeta }> {
  return segments
    .filter(s => s.annotation)
    .sort((a, b) => a.start - b.start)
    .map(segment => {
      const annotation = segment.annotation!;
      const isNew = sparkleAnnotationIds?.has(annotation.id) || false;
      return {
        start: segment.start,
        end: segment.end,
        meta: getAnnotationDecorationMeta(annotation, isNew, {
          ...(segment.strategy !== undefined ? { strategy: segment.strategy } : {}),
          ...(segment.confidence !== undefined ? { confidence: segment.confidence } : {}),
        }),
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
  getTargetResourceName?: (resourceId: string) => string | undefined
): ReferenceWidgetMeta[] {
  return segments
    .filter(s => s.annotation && isReference(s.annotation))
    .sort((a, b) => a.end - b.end)
    .map(segment => {
      const annotation = segment.annotation!;
      const bodySource = getBodySource(annotation.body);
      const targetName = bodySource ? getTargetResourceName?.(bodySource) : undefined;
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
