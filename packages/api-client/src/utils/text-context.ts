/**
 * Text context extraction utilities for W3C Web Annotation TextQuoteSelector
 *
 * Provides robust prefix/suffix context extraction with word boundary detection
 * to ensure fuzzy anchoring works correctly when the same text appears multiple times.
 *
 * Also provides AI offset validation and correction for handling AI-generated annotations
 * where the model may return slightly incorrect character offsets.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */

import { findBestTextMatch, type MatchQuality } from './fuzzy-anchor';

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
  fuzzyMatched?: boolean; // True if we had to use fuzzy matching (minor text differences)
  matchQuality?: MatchQuality; // How we found the match
}


/**
 * Validate and correct AI-provided annotation offsets with fuzzy matching tolerance
 *
 * AI models sometimes return offsets that don't match the actual text position,
 * or provide text with minor variations (case differences, whitespace, typos).
 *
 * This function uses a multi-strategy approach:
 * 1. Check if AI's offsets are exactly correct
 * 2. Try exact case-sensitive search
 * 3. Try case-insensitive search
 * 4. Try fuzzy matching with Levenshtein distance (5% tolerance)
 *
 * This ensures we're maximally tolerant of AI errors while still maintaining
 * annotation quality and logging what corrections were made.
 *
 * @param content - Full text content
 * @param aiStart - Start offset from AI
 * @param aiEnd - End offset from AI
 * @param exact - The exact text that should be at this position (from AI)
 * @returns Validated annotation with corrected offsets and context
 * @throws Error if no acceptable match can be found
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
 * // Returns: { start: 1161, end: 1303, exact: "...", corrected: true, matchQuality: 'exact', ... }
 * ```
 */
export function validateAndCorrectOffsets(
  content: string,
  aiStart: number,
  aiEnd: number,
  exact: string
): ValidatedAnnotation {
  const exactPreview = exact.length > 50 ? exact.substring(0, 50) + '...' : exact;

  // First, check if AI's offsets are correct
  const textAtOffset = content.substring(aiStart, aiEnd);

  if (textAtOffset === exact) {
    // AI got it right! Just add proper context
    console.log(`[validateAndCorrectOffsets] ✓ Offsets correct for: "${exactPreview}"`);
    const context = extractContext(content, aiStart, aiEnd);
    return {
      start: aiStart,
      end: aiEnd,
      exact,
      prefix: context.prefix,
      suffix: context.suffix,
      corrected: false,
      matchQuality: 'exact'
    };
  }

  // AI's offsets are wrong - try to find the text using multiple strategies
  const foundPreview = textAtOffset.length > 50 ? textAtOffset.substring(0, 50) + '...' : textAtOffset;

  console.warn(
    '[validateAndCorrectOffsets] ⚠ AI offset mismatch:\n' +
    `  Expected text: "${exactPreview}"\n` +
    `  Found at AI offset (${aiStart}-${aiEnd}): "${foundPreview}"\n` +
    `  Attempting multi-strategy search...`
  );

  const match = findBestTextMatch(content, exact, aiStart);

  if (!match) {
    const exactLong = exact.length > 100 ? exact.substring(0, 100) + '...' : exact;
    console.error(
      '[validateAndCorrectOffsets] ✗ No acceptable match found:\n' +
      `  AI offsets: start=${aiStart}, end=${aiEnd}\n` +
      `  AI text: "${exactLong}"\n` +
      `  Text at AI offset: "${foundPreview}"\n` +
      '  All search strategies (exact, case-insensitive, fuzzy) failed.\n' +
      '  This suggests the AI hallucinated text that doesn\'t exist in the document.'
    );
    throw new Error(
      'Cannot find acceptable match for text in content. ' +
      'All search strategies failed. Text may be hallucinated.'
    );
  }

  // Found a match! Extract the actual text from content
  const actualText = content.substring(match.start, match.end);
  const actualPreview = actualText.length > 50 ? actualText.substring(0, 50) + '...' : actualText;

  const offsetDelta = match.start - aiStart;
  const matchSymbol = match.matchQuality === 'exact' ? '✓' : match.matchQuality === 'case-insensitive' ? '≈' : '~';

  console.warn(
    `[validateAndCorrectOffsets] ${matchSymbol} Found ${match.matchQuality} match:\n` +
    `  AI offsets: start=${aiStart}, end=${aiEnd}\n` +
    `  Corrected: start=${match.start}, end=${match.end}\n` +
    `  Offset delta: ${offsetDelta} characters\n` +
    `  Actual text: "${actualPreview}"`
  );

  // If fuzzy match, log the difference for debugging
  if (match.matchQuality === 'fuzzy') {
    console.warn(
      '[validateAndCorrectOffsets] Fuzzy match details:\n' +
      `  AI provided: "${exactPreview}"\n` +
      `  Found in doc: "${actualPreview}"\n` +
      '  Minor text differences detected - using document version'
    );
  }

  // Extract context using corrected offsets
  const context = extractContext(content, match.start, match.end);

  return {
    start: match.start,
    end: match.end,
    exact: actualText, // Use actual text from document, not AI's version
    prefix: context.prefix,
    suffix: context.suffix,
    corrected: true,
    fuzzyMatched: match.matchQuality !== 'exact',
    matchQuality: match.matchQuality
  };
}
