/**
 * Selector reconciliation for write-time annotation construction.
 *
 * LLM-produced text offsets are guides, not authoritative anchors.
 * `reconcileSelector` takes whatever the LLM emitted and produces a
 * `TextQuoteSelector`-equivalent `start`/`end`/`exact`/`prefix`/`suffix`
 * that is provably consistent with the source content:
 *
 *   - `content.substring(start, end) === exact`
 *   - `content.substring(start - prefix.length, start) === prefix`
 *   - `content.substring(end, end + suffix.length) === suffix`
 *
 * No caller spreads LLM-emitted prefix/suffix into the stored selector.
 * The shared helper extracts both from source at the corrected position,
 * so the no-overlap invariant holds by construction.
 *
 * Returns `null` when the LLM emitted text that doesn't appear in the
 * source. Callers filter; the helper doesn't decide for them.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */
import { type MatchQuality } from './fuzzy-anchor';
/**
 * How the reconciliation arrived at the chosen offset. Carried into the
 * worker log so operators can audit ambiguous matches; the
 * `first-of-many` flag, in particular, is the signal that an annotation
 * *may* be anchored at the wrong occurrence and warrants review.
 */
export type AnchorMethod = 
/** Exact text appears once in the source — anchored unambiguously. */
'unique-match'
/** Multiple occurrences; LLM-emitted prefix/suffix picked one. */
 | 'context-recovered'
/** Exact text not found verbatim; fuzzy match recovered it. */
 | 'fuzzy-match'
/** Multiple occurrences, no context disambiguated — risky fallback. */
 | 'first-of-many';
export interface ReconciledSelector {
    start: number;
    end: number;
    /** Always a substring of the source content — never the LLM's emission. */
    exact: string;
    /** Extracted from source via extractContext — never the LLM's emission. */
    prefix?: string;
    /** Extracted from source via extractContext — never the LLM's emission. */
    suffix?: string;
    anchorMethod: AnchorMethod;
    /** Present when the fuzzy fallback recovered the match, naming how. */
    matchQuality?: MatchQuality;
}
export interface LlmSelectorInput {
    exact: string;
    /** LLM-emitted context for disambiguation only — not for storage. */
    prefix?: string;
    /** LLM-emitted context for disambiguation only — not for storage. */
    suffix?: string;
}
/**
 * Extract prefix and suffix context for a `TextQuoteSelector` from
 * source content. Used internally by `reconcileSelector` after offsets
 * are reconciled, and exported for callers (e.g. UI-side selection
 * capture) that need the same extraction semantics.
 *
 * Extracts up to 64 characters before and after the selected text,
 * extending up to 32 additional chars to reach a word boundary so the
 * prefix/suffix is meaningful context rather than mid-word fragments.
 */
export declare function extractContext(content: string, start: number, end: number): {
    prefix?: string;
    suffix?: string;
};
/**
 * Reconcile LLM-emitted offsets against the source. Returns a selector
 * whose `start`/`end` are verified to bracket `exact` in `content`, and
 * whose `prefix`/`suffix` are extracted from source — never carried
 * verbatim from the LLM.
 *
 * Returns `null` if `exact` cannot be found anywhere in the content,
 * even via fuzzy match. Callers filter null and log the drop.
 */
export declare function reconcileSelector(content: string, llm: LlmSelectorInput): ReconciledSelector | null;
