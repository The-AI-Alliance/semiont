/**
 * Text segmentation for annotation rendering
 *
 * Splits document text into segments, matching each annotation to its
 * position using fuzzy anchoring (TextQuoteSelector) with fallback to
 * exact positions (TextPositionSelector).
 *
 * No React dependencies — safe to use in any JavaScript environment.
 */

import type { components } from '@semiont/core';
import { getTextPositionSelector, getTextQuoteSelector, getTargetSelector, findTextWithContext, buildContentCache } from '@semiont/api-client';
import type { TextSegment } from './codemirror-logic';

type Annotation = components['schemas']['Annotation'];

// Re-export for consumers
export type { TextSegment };

/**
 * Segment text with annotations — uses fuzzy anchoring when available.
 *
 * For each annotation, tries TextQuoteSelector (fuzzy) first, then falls
 * back to TextPositionSelector (exact). Handles overlapping annotations
 * by skipping later ones that overlap earlier ones.
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

      // Try fuzzy anchoring if TextQuoteSelector is available
      // Pass TextPositionSelector as position hint for better fuzzy search
      let position;
      if (quoteSelector) {
        position = findTextWithContext(
          content,
          quoteSelector.exact,
          quoteSelector.prefix,
          quoteSelector.suffix,
          posSelector?.start,
          cache
        );
      }

      // Fallback to TextPositionSelector or fuzzy position
      const start = position?.start ?? posSelector?.start ?? 0;
      const end = position?.end ?? posSelector?.end ?? 0;

      return {
        annotation: ann,
        start,
        end
      };
    })
    .filter(a => a.start >= 0 && a.end <= content.length && a.start < a.end)
    .sort((a, b) => a.start - b.start);

  if (normalizedAnnotations.length === 0) {
    return [{ exact: content, start: 0, end: content.length }];
  }

  const segments: TextSegment[] = [];
  let position = 0;

  for (const { annotation, start, end } of normalizedAnnotations) {
    if (start < position) continue; // Skip overlapping annotations

    // Add text before annotation
    if (start > position) {
      segments.push({
        exact: content.slice(position, start),
        start: position,
        end: start
      });
    }

    // Add annotated segment
    segments.push({
      exact: content.slice(start, end),
      annotation,
      start,
      end
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
