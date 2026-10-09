/**
 * The context of a span of a text: the text just before it and just after
 * it, as a `TextQuoteSelector` states them (`prefix`, `suffix`).
 *
 * `start` and `end` are offsets: they count Unicode code points from the
 * start of the content, and so does every length here (the 64 and the 32).
 * They are a string's own positions only in a text with no character outside
 * the Basic Multilingual Plane; a caller that slices a string converts them
 * with `textOffsets`. specs/src/annotations/reconcile-cases.json holds the
 * rule, under CONTEXT.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */

import { between, textOffsets, type TextOffsets } from './text-offsets';

// Code points, both.
const CONTEXT_LENGTH = 64;
const MAX_EXTENSION = 32;

/** What a context is not lengthened past: white space, or one of eighteen marks. */
const BOUNDARY = /[\s.,;:!?'"()\[\]{}<>\/\\]/;

/**
 * Extract prefix and suffix context for a `TextQuoteSelector` from
 * source content: what `reconcile` gives a span it found, and what a caller
 * that makes a span another way (a selection in a viewer, say) gives its own.
 *
 * Extracts up to 64 code points before and after the selected text,
 * extending by up to 32 more to reach a word boundary so the
 * prefix/suffix is meaningful context rather than mid-word fragments.
 *
 * `start` and `end` are offsets: they count code points from the start of
 * `content`.
 */
export function extractContext(
  content: string,
  start: number,
  end: number,
): { prefix?: string; suffix?: string } {
  return contextOf(content, textOffsets(content), start, end);
}

/** `extractContext`, given the content's conversions: a caller with several spans of one content makes them once. */
export function contextOf(
  content: string,
  offsets: TextOffsets,
  start: number,
  end: number,
): { prefix?: string; suffix?: string } {
  const result: { prefix?: string; suffix?: string } = {};

  if (start > 0) {
    let prefixStart = Math.max(0, start - CONTEXT_LENGTH);
    let extensionCount = 0;
    while (prefixStart > 0 && extensionCount < MAX_EXTENSION) {
      if (BOUNDARY.test(between(content, offsets, prefixStart - 1, prefixStart))) break;
      prefixStart--;
      extensionCount++;
    }
    result.prefix = between(content, offsets, prefixStart, start);
  }

  if (end < offsets.length) {
    let suffixEnd = Math.min(offsets.length, end + CONTEXT_LENGTH);
    let extensionCount = 0;
    while (suffixEnd < offsets.length && extensionCount < MAX_EXTENSION) {
      if (BOUNDARY.test(between(content, offsets, suffixEnd, suffixEnd + 1))) break;
      suffixEnd++;
      extensionCount++;
    }
    result.suffix = between(content, offsets, end, suffixEnd);
  }

  return result;
}
