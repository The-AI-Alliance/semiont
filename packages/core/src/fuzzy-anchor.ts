/**
 * Fuzzy Anchoring for W3C Web Annotation TextQuoteSelector
 *
 * Uses prefix/suffix context to disambiguate when the same text appears multiple times.
 * Implements fuzzy matching as specified in the W3C Web Annotation Data Model.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */

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
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy matching when exact text doesn't match
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0]![j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      const deletion = matrix[i - 1]![j]! + 1;
      const insertion = matrix[i]![j - 1]! + 1;
      const substitution = matrix[i - 1]![j - 1]! + cost;
      matrix[i]![j] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[len1]![len2]!;
}

/**
 * Pre-computed content strings for batch fuzzy matching.
 * Avoids recomputing normalizeText(content) and content.toLowerCase()
 * for every annotation when processing many annotations against the same content.
 *
 * `normalizedMap[i]` is the original-content index that normalized
 * character `i` came from. It has length `normalizedContent.length + 1`;
 * the final entry is `content.length` so a match that ends at the end of
 * the normalized string maps back to the end of the original. This map is
 * how `findBestTextMatch` recovers the *original* offset of a normalized
 * match — counting char-by-char with `normalizeText(singleChar)` is
 * wrong, because a lone whitespace char trims to `''` (contributing 0)
 * while in a full-string normalize it collapses to a single space
 * (contributing 1). That discrepancy shifted recovered offsets by the
 * number of whitespace runs before the match.
 */
export interface ContentCache {
  normalizedContent: string;
  normalizedMap: number[];
  lowerContent: string;
}

/**
 * Normalize text and, in the same pass, build a map from each normalized
 * character position back to the original-content index it came from.
 * The produced `normalized` string is identical to `normalizeText(input)`
 * — a test pins this equivalence so the two can't drift.
 */
export function normalizeTextWithMap(input: string): { normalized: string; map: number[] } {
  let normalized = '';
  const map: number[] = [];

  // First pass mirrors normalizeText exactly, char by char, recording the
  // origin index for every emitted normalized character.
  let pendingWhitespaceStart = -1; // origin index of an open whitespace run, or -1

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

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      if (pendingWhitespaceStart === -1) pendingWhitespaceStart = i;
      continue;
    }
    flushWhitespace();
    if (ch === '‘' || ch === '’') {
      normalized += "'"; map.push(i);
    } else if (ch === '“' || ch === '”') {
      normalized += '"'; map.push(i);
    } else if (ch === '—') {
      normalized += '--'; map.push(i); map.push(i);
    } else if (ch === '–') {
      normalized += '-'; map.push(i);
    } else {
      normalized += ch; map.push(i);
    }
  }
  // A trailing whitespace run is dropped by trim — do not flush it.

  // `normalizeText` applies `.trim()` last. Our run logic already drops a
  // trailing whitespace run; a leading run is dropped because flushWhitespace
  // only runs before a non-space char, so a run at the very start is never
  // emitted. Both ends match trim().
  map.push(input.length); // sentinel: one past the last normalized char
  return { normalized, map };
}

/**
 * Build a ContentCache for a given content string.
 * Call once per content, pass to findBestTextMatch/anchorAnnotation for all annotations.
 */
export function buildContentCache(content: string): ContentCache {
  const { normalized, map } = normalizeTextWithMap(content);
  return {
    normalizedContent: normalized,
    normalizedMap: map,
    lowerContent: content.toLowerCase()
  };
}

/**
 * Find best match for text in content using multi-strategy search
 *
 * Shared core logic used by both anchorAnnotation (render-time) and
 * reconcileSelector (write-time).
 *
 * @param content - Full text content to search within
 * @param searchText - The text to find
 * @param positionHint - Hint for where to search (TextPositionSelector.start)
 * @param cache - Pre-computed normalized/lowered content (from buildContentCache)
 * @returns Match with position and quality, or null if not found
 */
export function findBestTextMatch(
  content: string,
  searchText: string,
  positionHint: number | undefined,
  cache: ContentCache
): { start: number; end: number; matchQuality: MatchQuality } | null {
  const maxFuzzyDistance = Math.max(5, Math.floor(searchText.length * 0.05)); // 5% tolerance or min 5 chars

  // Strategy 1: Exact match (case-sensitive, exact whitespace)
  const exactIndex = content.indexOf(searchText);
  if (exactIndex !== -1) {
    return {
      start: exactIndex,
      end: exactIndex + searchText.length,
      matchQuality: 'exact'
    };
  }

  // Strategy 2: Normalized match (handles whitespace/quote variations).
  // Map the normalized match position back to the original via the
  // precomputed index map. The naive char-by-char re-normalize is wrong:
  // a lone whitespace char trims to '' (0-width) but collapses to a single
  // space (1-width) in a full normalize, so it under-counts by the number
  // of whitespace runs before the match, shifting the recovered offset.
  const normalizedSearch = normalizeText(searchText);
  const normalizedIndex = cache.normalizedContent.indexOf(normalizedSearch);
  if (normalizedIndex !== -1) {
    const start = cache.normalizedMap[normalizedIndex] ?? 0;
    const end = cache.normalizedMap[normalizedIndex + normalizedSearch.length] ?? content.length;
    return {
      start,
      end,
      matchQuality: 'normalized'
    };
  }

  // Strategy 3: Case-insensitive match
  const lowerSearch = searchText.toLowerCase();
  const caseInsensitiveIndex = cache.lowerContent.indexOf(lowerSearch);
  if (caseInsensitiveIndex !== -1) {
    return {
      start: caseInsensitiveIndex,
      end: caseInsensitiveIndex + searchText.length,
      matchQuality: 'case-insensitive'
    };
  }

  // Strategy 4: Fuzzy match using Levenshtein distance with sliding window
  // Search near position hint if provided, otherwise search full content
  const windowSize = searchText.length;
  const searchRadius = Math.min(500, content.length);
  const searchStart = positionHint !== undefined
    ? Math.max(0, positionHint - searchRadius)
    : 0;
  const searchEnd = positionHint !== undefined
    ? Math.min(content.length, positionHint + searchRadius)
    : content.length;

  let bestMatch: { start: number; distance: number } | null = null;

  // Scan through content with sliding window
  for (let i = searchStart; i <= searchEnd - windowSize; i++) {
    const candidate = content.substring(i, i + windowSize);
    const distance = levenshteinDistance(searchText, candidate);

    if (distance <= maxFuzzyDistance) {
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { start: i, distance };
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
 */
export function verifyPosition(
  content: string,
  position: TextPosition,
  expectedExact: string
): boolean {
  const actualText = content.substring(position.start, position.end);
  return actualText === expectedExact;
}
