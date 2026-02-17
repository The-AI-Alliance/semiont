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

/**
 * Find text using exact match with optional prefix/suffix context
 *
 * When the exact text appears multiple times in the content, prefix and suffix
 * are used to disambiguate and find the correct occurrence.
 *
 * @param content - Full text content to search within
 * @param exact - The exact text to find
 * @param prefix - Optional text that should appear immediately before the match
 * @param suffix - Optional text that should appear immediately after the match
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
  suffix?: string
): TextPosition | null {
  if (!exact) return null;

  // Find all occurrences of exact text
  const occurrences: number[] = [];
  let index = content.indexOf(exact);
  while (index !== -1) {
    occurrences.push(index);
    index = content.indexOf(exact, index + 1);
  }

  // No matches found
  if (occurrences.length === 0) {
    console.warn(`[FuzzyAnchor] Text not found: "${exact.substring(0, 50)}..."`);
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
        console.warn(`[FuzzyAnchor] Using fuzzy match at position ${pos}`);
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
