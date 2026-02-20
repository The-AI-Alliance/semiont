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
 * Find best match for text in content using multi-strategy search
 *
 * Shared core logic used by both findTextWithContext and validateAndCorrectOffsets.
 *
 * @param content - Full text content to search within
 * @param searchText - The text to find
 * @param positionHint - Optional hint for where to search (TextPositionSelector.start)
 * @returns Match with position and quality, or null if not found
 */
export function findBestTextMatch(
  content: string,
  searchText: string,
  positionHint?: number
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
  const normalizedContent = normalizeText(content);
  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);
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
  const lowerContent = content.toLowerCase();
  const lowerSearch = searchText.toLowerCase();
  const caseInsensitiveIndex = lowerContent.indexOf(lowerSearch);
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
 * Find text using exact match with optional prefix/suffix context
 *
 * When the exact text appears multiple times in the content, prefix and suffix
 * are used to disambiguate and find the correct occurrence.
 *
 * If exact text is not found, uses multi-strategy fuzzy matching (normalization,
 * case-insensitive, Levenshtein distance) to locate changed text.
 *
 * @param content - Full text content to search within
 * @param exact - The exact text to find
 * @param prefix - Optional text that should appear immediately before the match
 * @param suffix - Optional text that should appear immediately after the match
 * @param positionHint - Optional position hint (from TextPositionSelector) for fuzzy search
 * @returns Position of the matched text, or null if not found
 *
 * @example
 * ```typescript
 * const content = "The cat sat. The cat ran.";
 * // Find second "The cat" occurrence
 * const pos = findTextWithContext(content, "The cat", "sat. ", " ran");
 * // Returns { start: 13, end: 20 }
 * ```
 */
export function findTextWithContext(
  content: string,
  exact: string,
  prefix?: string,
  suffix?: string,
  positionHint?: number
): TextPosition | null {
  if (!exact) return null;

  // Find all occurrences of exact text
  const occurrences: number[] = [];
  let index = content.indexOf(exact);
  while (index !== -1) {
    occurrences.push(index);
    index = content.indexOf(exact, index + 1);
  }

  // No exact matches found - try fuzzy matching
  if (occurrences.length === 0) {
    console.warn(`[FuzzyAnchor] Exact text not found, trying fuzzy match: "${exact.substring(0, 50)}..."`);

    const fuzzyMatch = findBestTextMatch(content, exact, positionHint);

    if (fuzzyMatch) {
      console.warn(
        `[FuzzyAnchor] Found ${fuzzyMatch.matchQuality} match at position ${fuzzyMatch.start}`
      );
      return { start: fuzzyMatch.start, end: fuzzyMatch.end };
    }

    console.warn(`[FuzzyAnchor] No acceptable match found for: "${exact.substring(0, 50)}..."`);
    return null;
  }

  // Only one match - no need for prefix/suffix disambiguation
  if (occurrences.length === 1) {
    const pos = occurrences[0]!; // Safe: length === 1 means first element exists
    return { start: pos, end: pos + exact.length };
  }

  // Multiple matches - use prefix/suffix to disambiguate
  if (prefix || suffix) {
    for (const pos of occurrences) {
      // Extract actual prefix from content
      const actualPrefixStart = Math.max(0, pos - (prefix?.length || 0));
      const actualPrefix = content.substring(actualPrefixStart, pos);

      // Extract actual suffix from content
      const actualSuffixEnd = Math.min(content.length, pos + exact.length + (suffix?.length || 0));
      const actualSuffix = content.substring(pos + exact.length, actualSuffixEnd);

      // Check if prefix matches
      const prefixMatch = !prefix || actualPrefix.endsWith(prefix);

      // Check if suffix matches
      const suffixMatch = !suffix || actualSuffix.startsWith(suffix);

      if (prefixMatch && suffixMatch) {
        return { start: pos, end: pos + exact.length };
      }
    }

    // No match with exact prefix/suffix - try fuzzy matching
    console.warn(
      `[FuzzyAnchor] Multiple matches found but none match prefix/suffix exactly. ` +
      `Exact: "${exact.substring(0, 30)}...", ` +
      `Prefix: "${prefix?.substring(0, 20) || 'none'}", ` +
      `Suffix: "${suffix?.substring(0, 20) || 'none'}"`
    );

    // Fallback: try partial prefix/suffix match
    for (const pos of occurrences) {
      const actualPrefix = content.substring(Math.max(0, pos - (prefix?.length || 0)), pos);
      const actualSuffix = content.substring(pos + exact.length, pos + exact.length + (suffix?.length || 0));

      // Fuzzy match: check if prefix/suffix are substrings (handles whitespace variations)
      const fuzzyPrefixMatch = !prefix || actualPrefix.includes(prefix.trim());
      const fuzzySuffixMatch = !suffix || actualSuffix.includes(suffix.trim());

      if (fuzzyPrefixMatch && fuzzySuffixMatch) {
        console.warn(`[FuzzyAnchor] Using fuzzy context match at position ${pos}`);
        return { start: pos, end: pos + exact.length };
      }
    }
  }

  // Fallback: return first occurrence if no prefix/suffix or no match
  console.warn(
    `[FuzzyAnchor] Multiple matches but no context match. Using first occurrence. ` +
    `Exact: "${exact.substring(0, 30)}..."`
  );
  const pos = occurrences[0]!; // Safe: we checked length > 0 earlier
  return { start: pos, end: pos + exact.length };
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
