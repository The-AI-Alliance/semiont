/**
 * Text segmentation for annotation rendering
 *
 * Splits document text into segments, matching each annotation to its
 * position using fuzzy anchoring (TextQuoteSelector) with fallback to
 * exact positions (TextPositionSelector).
 *
 * No React dependencies — safe to use in any JavaScript environment.
 */

import { getTextPositionSelector, getTextQuoteSelector, getTargetSelector } from '@semiont/core';
import { anchorAnnotation, buildContentCache, type AnchorStrategy, type AnchorConfidence } from '@semiont/core';
import type { TextSegment } from './codemirror-logic';

import type { Annotation } from '@semiont/core';

// Re-export for consumers
export type { TextSegment };

/**
 * Annotations already warned about. The renderer can re-anchor the same
 * annotation many times (re-render, scroll, layout) — log the degraded
 * strategy once and suppress for the lifetime of the page. Cleared only
 * by full reload, which matches the operator workflow: see a warning,
 * investigate, fix the data, reload to confirm.
 */
const warnedAnnotationIds = new Set<string>();

/**
 * Segment text with annotations — anchors each annotation via
 * `anchorAnnotation`, which combines position and quote selectors with a
 * scoring algorithm. Handles overlapping annotations by skipping later
 * ones that overlap earlier ones.
 *
 * Strategy + confidence flow through to the returned segments so the
 * CodeMirror decoration layer can add data attributes for low-confidence
 * affordances. Anything below `confidence: 'high'` also logs a one-shot
 * `console.warn` so operators see when the corpus has anchor drift.
 *
 * @param content - Full document text
 * @param annotations - Array of W3C annotations with target selectors
 * @returns Array of TextSegments covering the full content
 */
export function segmentTextWithAnnotations(content: string, annotations: Annotation[]): TextSegment[] {
  if (!content) {
    return [{ exact: '', start: 0, end: 0 }];
  }

  // Pre-compute normalized/lowered content once for all annotations
  const cache = buildContentCache(content);

  const normalizedAnnotations = annotations
    .map(ann => {
      const targetSelector = getTargetSelector(ann.target);
      const posSelector = getTextPositionSelector(targetSelector);
      const quoteSelector = targetSelector ? getTextQuoteSelector(targetSelector) : null;

      const anchor = anchorAnnotation(
        content,
        {
          ...(posSelector ? { position: { start: posSelector.start, end: posSelector.end } } : {}),
          ...(quoteSelector
            ? {
                quote: {
                  exact: quoteSelector.exact,
                  ...(quoteSelector.prefix !== undefined ? { prefix: quoteSelector.prefix } : {}),
                  ...(quoteSelector.suffix !== undefined ? { suffix: quoteSelector.suffix } : {}),
                },
              }
            : {}),
        },
        cache,
      );

      if (anchor && anchor.confidence !== 'high') {
        logDegradedAnchorOnce(ann.id, anchor.strategy, anchor.confidence);
      }

      return {
        annotation: ann,
        start: anchor?.start ?? 0,
        end: anchor?.end ?? 0,
        ...(anchor?.strategy ? { strategy: anchor.strategy } : {}),
        ...(anchor?.confidence ? { confidence: anchor.confidence } : {}),
      };
    })
    .filter(a => a.start >= 0 && a.end <= content.length && a.start < a.end)
    .sort((a, b) => a.start - b.start);

  if (normalizedAnnotations.length === 0) {
    return [{ exact: content, start: 0, end: content.length }];
  }

  const segments: TextSegment[] = [];
  let position = 0;

  for (const { annotation, start, end, strategy, confidence } of normalizedAnnotations) {
    if (start < position) continue; // Skip overlapping annotations

    // Add text before annotation
    if (start > position) {
      segments.push({
        exact: content.slice(position, start),
        start: position,
        end: start
      });
    }

    // Add annotated segment — carry strategy/confidence through so the
    // CodeMirror decoration layer can surface the low-confidence
    // affordance without re-running the anchoring pass.
    segments.push({
      exact: content.slice(start, end),
      annotation,
      start,
      end,
      ...(strategy ? { strategy } : {}),
      ...(confidence ? { confidence } : {}),
    });

    position = end;
  }

  // Add remaining text
  if (position < content.length) {
    segments.push({
      exact: content.slice(position),
      start: position,
      end: content.length
    });
  }

  return segments;
}

/**
 * Reset the once-per-annotation log cache. Intended for tests; in
 * production the cache lives for the page lifetime.
 */
export function _resetDegradedAnchorWarnings(): void {
  warnedAnnotationIds.clear();
}

function logDegradedAnchorOnce(
  annotationId: string,
  strategy: AnchorStrategy,
  confidence: AnchorConfidence,
): void {
  if (warnedAnnotationIds.has(annotationId)) return;
  warnedAnnotationIds.add(annotationId);
  console.warn('[segmentTextWithAnnotations] annotation anchored via degraded strategy', {
    annotationId,
    strategy,
    confidence,
  });
}
