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
 */
export interface ContentCache {
  normalizedContent: string;
  lowerContent: string;
}

/**
 * Build a ContentCache for a given content string.
 * Call once per content, pass to findBestTextMatch/anchorAnnotation for all annotations.
 */
export function buildContentCache(content: string): ContentCache {
  return {
    normalizedContent: normalizeText(content),
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

  // Strategy 2: Normalized match (handles whitespace/quote variations)
  const normalizedSearch = normalizeText(searchText);
  const normalizedIndex = cache.normalizedContent.indexOf(normalizedSearch);
  if (normalizedIndex !== -1) {
    // Find actual position in original content by counting characters
    let actualPos = 0;
    let normalizedPos = 0;
    while (normalizedPos < normalizedIndex && actualPos < content.length) {
      const char = content[actualPos]!;
      const normalizedChar = normalizeText(char);
      if (normalizedChar) {
        normalizedPos += normalizedChar.length;
      }
      actualPos++;
    }
    return {
      start: actualPos,
      end: actualPos + searchText.length,
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
