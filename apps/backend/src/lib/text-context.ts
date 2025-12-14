/**
 * Text context extraction utilities for W3C Web Annotation TextQuoteSelector
 *
 * Provides robust prefix/suffix context extraction with word boundary detection
 * to ensure fuzzy anchoring works correctly when the same text appears multiple times.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */

/**
 * Extract prefix and suffix context for TextQuoteSelector
 *
 * Extracts up to 64 characters before and after the selected text,
 * extending to word boundaries to avoid cutting words in half.
 * This ensures prefix/suffix are meaningful context for fuzzy anchoring.
 *
 * @param content - Full text content
 * @param start - Start offset of selection
 * @param end - End offset of selection
 * @returns Object with prefix and suffix (undefined if at boundaries)
 *
 * @example
 * ```typescript
 * const content = "The United States Congress...";
 * const context = extractContext(content, 4, 17); // "United States"
 * // Returns: { prefix: "The ", suffix: " Congress..." }
 * // NOT: { prefix: "nited ", suffix: "gress..." }
 * ```
 */
export function extractContext(
  content: string,
  start: number,
  end: number
): { prefix?: string; suffix?: string } {
  const CONTEXT_LENGTH = 64;
  const MAX_EXTENSION = 32; // Maximum additional chars to extend for word boundary

  // Extract prefix (up to CONTEXT_LENGTH chars before start, extended to word boundary)
  let prefix: string | undefined;
  if (start > 0) {
    let prefixStart = Math.max(0, start - CONTEXT_LENGTH);

    // Extend backward to word boundary (whitespace or punctuation)
    // Stop if we hit start of content or exceed MAX_EXTENSION
    let extensionCount = 0;
    while (prefixStart > 0 && extensionCount < MAX_EXTENSION) {
      const char = content[prefixStart - 1];
      // Break on whitespace, punctuation, or common delimiters
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) {
        break;
      }
      prefixStart--;
      extensionCount++;
    }

    prefix = content.substring(prefixStart, start);
  }

  // Extract suffix (up to CONTEXT_LENGTH chars after end, extended to word boundary)
  let suffix: string | undefined;
  if (end < content.length) {
    let suffixEnd = Math.min(content.length, end + CONTEXT_LENGTH);

    // Extend forward to word boundary (whitespace or punctuation)
    // Stop if we hit end of content or exceed MAX_EXTENSION
    let extensionCount = 0;
    while (suffixEnd < content.length && extensionCount < MAX_EXTENSION) {
      const char = content[suffixEnd];
      // Break on whitespace, punctuation, or common delimiters
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) {
        break;
      }
      suffixEnd++;
      extensionCount++;
    }

    suffix = content.substring(end, suffixEnd);
  }

  return { prefix, suffix };
}
