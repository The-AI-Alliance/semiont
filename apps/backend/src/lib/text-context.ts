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

/**
 * Result of validating and correcting AI-provided annotation offsets
 */
export interface ValidatedAnnotation {
  start: number;
  end: number;
  exact: string;
  prefix?: string;
  suffix?: string;
  corrected: boolean; // True if offsets were adjusted from AI's original values
}

/**
 * Validate and correct AI-provided annotation offsets
 *
 * AI models sometimes return offsets that don't match the actual text position.
 * This function:
 * 1. Validates that content.substring(start, end) === exact
 * 2. If validation fails, searches for the exact text in content
 * 3. Returns corrected offsets and proper prefix/suffix context
 *
 * This ensures TextPositionSelector and TextQuoteSelector are always consistent.
 *
 * @param content - Full text content
 * @param aiStart - Start offset from AI
 * @param aiEnd - End offset from AI
 * @param exact - The exact text that should be at this position
 * @returns Validated annotation with corrected offsets and context
 * @throws Error if exact text cannot be found in content
 *
 * @example
 * ```typescript
 * // AI said start=1143, but actual text is at 1161
 * const result = validateAndCorrectOffsets(
 *   content,
 *   1143,
 *   1289,
 *   "the question \"whether..."
 * );
 * // Returns: { start: 1161, end: 1303, exact: "...", corrected: true, prefix: "...", suffix: "..." }
 * ```
 */
export function validateAndCorrectOffsets(
  content: string,
  aiStart: number,
  aiEnd: number,
  exact: string
): ValidatedAnnotation {
  // First, check if AI's offsets are correct
  const textAtOffset = content.substring(aiStart, aiEnd);

  if (textAtOffset === exact) {
    // AI got it right! Just add proper context
    const context = extractContext(content, aiStart, aiEnd);
    return {
      start: aiStart,
      end: aiEnd,
      exact,
      prefix: context.prefix,
      suffix: context.suffix,
      corrected: false
    };
  }

  // AI's offsets are wrong - search for the exact text
  const exactPreview = exact.length > 50 ? exact.substring(0, 50) + '...' : exact;
  const foundPreview = textAtOffset.length > 50 ? textAtOffset.substring(0, 50) + '...' : textAtOffset;

  console.warn(
    '[validateAndCorrectOffsets] AI offset mismatch:\n' +
    `  Expected: "${exactPreview}"\n` +
    `  Found at offset: "${foundPreview}"\n` +
    '  Searching for correct position...'
  );

  const correctStart = content.indexOf(exact);

  if (correctStart === -1) {
    const exactLong = exact.length > 100 ? exact.substring(0, 100) + '...' : exact;
    throw new Error(
      'Cannot find exact text in content. AI provided:\n' +
      `  Start: ${aiStart}, End: ${aiEnd}\n` +
      `  Exact: "${exactLong}"\n` +
      '  This suggests the AI hallucinated text that doesn\'t exist in the document.'
    );
  }

  const correctEnd = correctStart + exact.length;

  console.warn(
    '[validateAndCorrectOffsets] Corrected offsets:\n' +
    `  AI said: start=${aiStart}, end=${aiEnd}\n` +
    `  Actual: start=${correctStart}, end=${correctEnd}\n` +
    `  Offset delta: ${correctStart - aiStart} characters`
  );

  // Extract context using corrected offsets
  const context = extractContext(content, correctStart, correctEnd);

  return {
    start: correctStart,
    end: correctEnd,
    exact,
    prefix: context.prefix,
    suffix: context.suffix,
    corrected: true
  };
}
