/**
 * Fuzzy Anchoring for W3C Web Annotation TextQuoteSelector
 *
 * Uses prefix/suffix context to disambiguate when the same text appears multiple times.
 * Implements fuzzy matching as specified in the W3C Web Annotation Data Model.
 *
 * A position in a text is an offset: it counts Unicode code points from the
 * start of the text, and so does every length a rule here states (the
 * stretch a quote is compared with, its allowance, an edit). A string's own
 * positions are converted with `textOffsets`, where the string is called.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */

import { occurrencesOf, textOffsets, type TextOffsets } from './text-offsets';

/** A span of a text, as two offsets: from `start` up to but not including `end`. */
export interface TextPosition {
  start: number;
  end: number;
}

export type MatchQuality = 'exact' | 'normalized' | 'case-insensitive' | 'fuzzy';

/**
 * Normalize text for comparison - handles common document editing changes
 *
 * Collapses whitespace, converts curly quotes to straight quotes,
 * and normalizes common punctuation variations.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ')              // collapse whitespace
    .replace(/[\u2018\u2019]/g, "'")   // curly single quotes → straight
    .replace(/[\u201C\u201D]/g, '"')   // curly double quotes → straight
    .replace(/\u2014/g, '--')          // em-dash → double hyphen
    .replace(/\u2013/g, '-')           // en-dash → hyphen
    .trim();
}

/**
 * Calculate Levenshtein distance between `wanted` and the stretch of `text`
 * that starts at `from` and is as long as it.
 * Used for fuzzy matching when exact text doesn't match.
 *
 * Both are code points, one to an element, so an edit is of one code point.
 */
function levenshteinDistance(wanted: readonly string[], text: readonly string[], from: number): number {
  const length = wanted.length;
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= length; j++) {
    matrix[0]![j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= length; i++) {
    for (let j = 1; j <= length; j++) {
      const cost = wanted[i - 1] === text[from + j - 1] ? 0 : 1;
      const deletion = matrix[i - 1]![j]! + 1;
      const insertion = matrix[i]![j - 1]! + 1;
      const substitution = matrix[i - 1]![j - 1]! + cost;
      matrix[i]![j] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[length]![length]!;
}

/**
 * Pre-computed content strings for batch fuzzy matching.
 * Avoids recomputing normalizeText(content) and content.toLowerCase()
 * for every annotation when processing many annotations against the same content.
 *
 * `normalizedMap[i]` is the offset, in the original content, of the
 * character that the code point at offset `i` of `normalizedContent` came
 * from. It has an entry for each code point of `normalizedContent` and one
 * more; the final entry is the content's length in code points, so a match
 * that ends at the end of the normalized string maps back to the end of the
 * original. This map is how `findBestTextMatch` recovers the *original*
 * offset of a normalized match — counting char-by-char with
 * `normalizeText(singleChar)` is wrong, because a lone whitespace char trims
 * to `''` (contributing 0) while in a full-string normalize it collapses to a
 * single space (contributing 1). That discrepancy shifts recovered offsets by
 * the number of whitespace runs before the match.
 */
export interface ContentCache {
  /** The content's conversions between its offsets and its string's positions. */
  offsets: TextOffsets;
  normalizedContent: string;
  /** The normalized content's own conversions: it is another string. */
  normalizedOffsets: TextOffsets;
  normalizedMap: number[];
  lowerContent: string;
  /** The lower-cased content's own conversions: it is another string, of another length where lower-casing changes one. */
  lowerOffsets: TextOffsets;
}

/**
 * Normalize text and, in the same pass, build a map from each offset of the
 * normalized text back to the offset, in the input, of the character it
 * came from. Both count code points: the map has one entry for each code
 * point of the normalized text, and one for its end.
 * The produced `normalized` string is identical to `normalizeText(input)`
 * — a test pins this equivalence so the two can't drift.
 */
export function normalizeTextWithMap(input: string): { normalized: string; map: number[] } {
  let normalized = '';
  const map: number[] = [];

  // First pass mirrors normalizeText exactly, char by char, recording the
  // origin offset for every emitted normalized character.
  let pendingWhitespaceStart = -1; // origin offset of an open whitespace run, or -1

  const flushWhitespace = () => {
    if (pendingWhitespaceStart !== -1) {
      // A whitespace run collapses to a single space, mapped to the run's
      // first char — but a *leading* run (nothing emitted yet) is dropped,
      // matching normalizeText's trailing `.trim()`.
      if (normalized.length > 0) {
        normalized += ' ';
        map.push(pendingWhitespaceStart);
      }
      pendingWhitespaceStart = -1;
    }
  };

  // The offset of `ch`: how many code points of `input` are before it. A
  // string is walked a code point at a time, so it is one more for each.
  let offset = 0;
  for (const ch of input) {
    if (/\s/.test(ch)) {
      if (pendingWhitespaceStart === -1) pendingWhitespaceStart = offset;
      offset++;
      continue;
    }
    flushWhitespace();
    if (ch === '‘' || ch === '’') {
      normalized += "'"; map.push(offset);
    } else if (ch === '“' || ch === '”') {
      normalized += '"'; map.push(offset);
    } else if (ch === '—') {
      normalized += '--'; map.push(offset); map.push(offset);
    } else if (ch === '–') {
      normalized += '-'; map.push(offset);
    } else {
      normalized += ch; map.push(offset);
    }
    offset++;
  }
  // A trailing whitespace run is dropped by trim — do not flush it.

  // `normalizeText` applies `.trim()` last. Our run logic already drops a
  // trailing whitespace run; a leading run is dropped because flushWhitespace
  // only runs before a non-space char, so a run at the very start is never
  // emitted. Both ends match trim().
  map.push(offset); // sentinel: the input's length in code points, one past its last character
  return { normalized, map };
}

/**
 * Build a ContentCache for a given content string, given the content's own
 * conversions (`textOffsets(content)`).
 * Call once per content, pass to findBestTextMatch for every search of it.
 */
export function buildContentCache(content: string, offsets: TextOffsets): ContentCache {
  const { normalized, map } = normalizeTextWithMap(content);
  const lowerContent = content.toLowerCase();
  return {
    offsets,
    normalizedContent: normalized,
    normalizedOffsets: textOffsets(normalized),
    normalizedMap: map,
    lowerContent,
    lowerOffsets: textOffsets(lowerContent),
  };
}

/**
 * Find best match for text in content using multi-strategy search
 *
 * The search `reconcileSelector` (write-time) falls back on.
 *
 * @param content - Full text content to search within
 * @param searchText - The text to find
 * @param positionHint - Hint for where to search (TextPositionSelector.start): an offset, in code points
 * @param cache - What is made once for the content (from buildContentCache)
 * @returns Match with position, as two offsets in code points, and quality, or null if not found
 */
export function findBestTextMatch(
  content: string,
  searchText: string,
  positionHint: number | undefined,
  cache: ContentCache
): { start: number; end: number; matchQuality: MatchQuality } | null {
  const { offsets } = cache;
  // The search text a code point to an element: its length is a count of
  // code points, and so is the stretch of content it is compared with.
  const wanted = Array.from(searchText);
  const windowSize = wanted.length;
  const maxFuzzyDistance = Math.max(5, Math.floor(windowSize * 0.05)); // 5% tolerance or min 5 code points

  // Strategy 1: Exact match (case-sensitive, exact whitespace)
  const [exactStart] = occurrencesOf(content, offsets, searchText);
  if (exactStart !== undefined) {
    return {
      start: exactStart,
      end: exactStart + windowSize,
      matchQuality: 'exact'
    };
  }

  // Strategy 2: Normalized match (handles whitespace/quote variations).
  // Map the normalized match position back to the original via the
  // precomputed offset map. The naive char-by-char re-normalize is wrong:
  // a lone whitespace char trims to '' (0-width) but collapses to a single
  // space (1-width) in a full normalize, so it under-counts by the number
  // of whitespace runs before the match, shifting the recovered offset.
  const normalizedSearch = normalizeText(searchText);
  const [normalizedStart] = occurrencesOf(cache.normalizedContent, cache.normalizedOffsets, normalizedSearch);
  if (normalizedStart !== undefined) {
    // The map has an entry for every offset of the normalized content, its
    // end included, so both of these are there.
    const start = cache.normalizedMap[normalizedStart]!;
    const end = cache.normalizedMap[normalizedStart + textOffsets(normalizedSearch).length]!;
    return {
      start,
      end,
      matchQuality: 'normalized'
    };
  }

  // Strategy 3: Case-insensitive match. Where the lower-cased content has
  // the words is taken for where the content has them: an offset in the one
  // string, used as an offset in the other.
  const [lowerStart] = occurrencesOf(cache.lowerContent, cache.lowerOffsets, searchText.toLowerCase());
  if (lowerStart !== undefined) {
    return {
      start: lowerStart,
      end: lowerStart + windowSize,
      matchQuality: 'case-insensitive'
    };
  }

  // Strategy 4: Fuzzy match using Levenshtein distance with sliding window
  // Search near position hint if provided, otherwise search full content
  const searchRadius = Math.min(500, offsets.length);
  const searchStart = positionHint !== undefined
    ? Math.max(0, positionHint - searchRadius)
    : 0;
  const searchEnd = positionHint !== undefined
    ? Math.min(offsets.length, positionHint + searchRadius)
    : offsets.length;
  // A hint past the end of the text leaves no stretch to search.
  if (searchStart > searchEnd) return null;

  // The stretch searched, a code point to an element: `stretch[i]` is the
  // content's code point at the offset `searchStart + i`.
  const stretch = Array.from(content.substring(offsets.indexAt(searchStart), offsets.indexAt(searchEnd)));

  let bestMatch: { start: number; distance: number } | null = null;

  // Scan through content with sliding window
  for (let i = 0; i <= stretch.length - windowSize; i++) {
    const distance = levenshteinDistance(wanted, stretch, i);

    if (distance <= maxFuzzyDistance) {
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { start: searchStart + i, distance };
      }
    }
  }

  if (bestMatch) {
    return {
      start: bestMatch.start,
      end: bestMatch.start + windowSize,
      matchQuality: 'fuzzy'
    };
  }

  return null;
}

/**
 * Verify that a position correctly points to the exact text
 * Useful for debugging and validation
 *
 * The position is two offsets, in code points. One the text does not have
 * (not a whole number, below zero, past the end, or ending before it starts)
 * points at nothing.
 */
export function verifyPosition(
  content: string,
  position: TextPosition,
  expectedExact: string
): boolean {
  const offsets = textOffsets(content);
  const { start, end } = position;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end > offsets.length || start > end) return false;
  const actualText = content.substring(offsets.indexAt(start), offsets.indexAt(end));
  return actualText === expectedExact;
}
