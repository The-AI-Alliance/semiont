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
export declare function normalizeText(text: string): string;
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
export declare function normalizeTextWithMap(input: string): {
    normalized: string;
    map: number[];
};
/**
 * Build a ContentCache for a given content string.
 * Call once per content, pass to findBestTextMatch/anchorAnnotation for all annotations.
 */
export declare function buildContentCache(content: string): ContentCache;
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
export declare function findBestTextMatch(content: string, searchText: string, positionHint: number | undefined, cache: ContentCache): {
    start: number;
    end: number;
    matchQuality: MatchQuality;
} | null;
/**
 * Verify that a position correctly points to the exact text
 * Useful for debugging and validation
 */
export declare function verifyPosition(content: string, position: TextPosition, expectedExact: string): boolean;
