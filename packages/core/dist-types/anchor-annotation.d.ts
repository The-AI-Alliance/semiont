/**
 * Anchor a W3C Web Annotation to its rendered text.
 *
 * Render-time cleverness is deliberately limited to **verbatim** quote
 * matching. The annotation's two selectors are written to agree (the
 * write-side `reconcileSelector` + `buildTextAnnotation` invariant
 * guarantee `content.substring(start, end) === exact`). At render time the
 * only legitimate discrepancy is *positional drift*: the document grew or
 * shrank above the span after the annotation was written, so the offset is
 * stale but the exact text still exists, byte-identical, elsewhere. That is
 * the W3C-intended role of `TextQuoteSelector`, and it is safe because it
 * demands identical text — no normalization, no fuzzy matching, no
 * judgment call.
 *
 * Anything that would require *fuzzy* recovery (smart-quote folding,
 * whitespace collapse, Levenshtein) is out of scope here: a non-verbatim
 * mismatch means the content representation diverged or the stored record
 * is wrong, both of which are deterministic and belong upstream (canonical
 * content, or a corrected annotation event). The renderer does not guess —
 * it renders at the stored offset and flags the anchor low-confidence so
 * the discrepancy surfaces for an upstream fix.
 *
 * Returns `null` only when nothing usable is present; otherwise always
 * returns a position with a `strategy` and `confidence`.
 */
export type AnchorStrategy = 
/** Position hint pointed exactly at the exact text. Unambiguous. */
'fast-path'
/** Exact text appears once verbatim in the content. No tiebreak needed. */
 | 'unique-occurrence'
/** Multiple verbatim occurrences; prefix+suffix uniquely identified one. */
 | 'context-disambiguated'
/** Multiple verbatim candidates; position closest to hint chosen. */
 | 'position-tiebreaker'
/** Exact text not found verbatim (or no quote); raw stored offset used,
 *  flagged for upstream correction. */
 | 'position-fallback';
export type AnchorConfidence = 'high' | 'medium' | 'low';
export interface RenderedAnchor {
    start: number;
    end: number;
    strategy: AnchorStrategy;
    confidence: AnchorConfidence;
}
export interface AnchorSelectors {
    position?: {
        start: number;
        end: number;
    };
    quote?: {
        exact: string;
        prefix?: string;
        suffix?: string;
    };
}
/**
 * Distance window for the position tiebreaker. Candidates closer than this
 * to the hint receive a non-zero position score; further candidates fall
 * back to zero. Tuned for typical document sizes; calibration tests pin
 * the boundary behaviour rather than the exact value.
 */
export declare const POSITION_WINDOW = 1024;
/**
 * Score weights — kept as named constants so the calibration tests can
 * import them and pin the *relationships* rather than the magnitudes.
 *
 * Invariant: a full-context match always outranks any position score.
 * (`CONTEXT_FULL_WEIGHT * 2 > POSITION_WEIGHT_MAX`, accounting for
 * prefix+suffix each contributing the full weight.)
 */
export declare const CONTEXT_FULL_WEIGHT = 10;
export declare const CONTEXT_PARTIAL_WEIGHT = 5;
export declare const POSITION_WEIGHT_MAX = 5;
/**
 * Locate the best-effort anchor for an annotation against the content the
 * renderer is about to display. Verbatim-only — see the module doc.
 */
export declare function anchorAnnotation(content: string, selectors: AnchorSelectors): RenderedAnchor | null;
