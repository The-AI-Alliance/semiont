/**
 * Two-stage citation search over an extracted PDF text layer
 * (PDF-GENERATION P4).
 *
 * A citation's `exact` claim text comes from the authored source; the rendered
 * text layer diverges from it in exactly two measured ways (the P0 spike):
 * line breaks (`anchorRuns` joins runs with " \n") and hyphenation (soft
 * hyphens are DROPPED — a hyphenated word yields its two halves with no hyphen
 * character anywhere).
 *
 * Two stages, in this order, never collapsed to one matcher:
 *
 *   1. STRICT — search a whitespace-normalized copy, offsets mapped back.
 *      Bridges plain line breaks (" \n" collapses to " ").
 *   2. BREAK-AWARE — only on a strict miss. The line break becomes a distinct
 *      marker character that may be absorbed in any inter-character gap, with
 *      an optional space on either side (anchorRuns emits a space *then* the
 *      newline). Ordinary spaces are NEVER wildcards, so "abc" cannot match
 *      "a b c" — only a real break is absorbable.
 *
 * The ordering is the safety property: the permissive matcher runs only where
 * the strict one already failed, so it can never turn a working citation into
 * a wrong one — only a failure into an unlikely mismatch.
 */
import type { AnchoredText } from './pdf-anchoring';
export declare function findClaimSpan(anchored: AnchoredText, exact: string): {
    start: number;
    end: number;
} | null;
