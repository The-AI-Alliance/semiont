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

import { findBestTextMatch, buildContentCache, type MatchQuality } from './fuzzy-anchor';

/**
 * How the reconciliation arrived at the chosen offset. Carried into the
 * worker log so operators can audit ambiguous matches; the
 * `first-of-many` flag, in particular, is the signal that an annotation
 * *may* be anchored at the wrong occurrence and warrants review.
 */
export type AnchorMethod =
  /** Exact text appears once in the source — anchored unambiguously. */
  | 'unique-match'
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

const CONTEXT_LENGTH = 64;
const MAX_EXTENSION = 32;
const DISAMBIGUATION_CONTEXT = 32;

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
export function extractContext(
  content: string,
  start: number,
  end: number,
): { prefix?: string; suffix?: string } {
  const result: { prefix?: string; suffix?: string } = {};

  if (start > 0) {
    let prefixStart = Math.max(0, start - CONTEXT_LENGTH);
    let extensionCount = 0;
    while (prefixStart > 0 && extensionCount < MAX_EXTENSION) {
      const char = content[prefixStart - 1];
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) break;
      prefixStart--;
      extensionCount++;
    }
    result.prefix = content.substring(prefixStart, start);
  }

  if (end < content.length) {
    let suffixEnd = Math.min(content.length, end + CONTEXT_LENGTH);
    let extensionCount = 0;
    while (suffixEnd < content.length && extensionCount < MAX_EXTENSION) {
      const char = content[suffixEnd];
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) break;
      suffixEnd++;
      extensionCount++;
    }
    result.suffix = content.substring(end, suffixEnd);
  }

  return result;
}

/**
 * Reconcile LLM-emitted offsets against the source. Returns a selector
 * whose `start`/`end` are verified to bracket `exact` in `content`, and
 * whose `prefix`/`suffix` are extracted from source — never carried
 * verbatim from the LLM.
 *
 * Returns `null` if `exact` cannot be found anywhere in the content,
 * even via fuzzy match. Callers filter null and log the drop.
 */
export function reconcileSelector(
  content: string,
  llm: LlmSelectorInput,
): ReconciledSelector | null {
  const { exact, prefix: llmPrefix, suffix: llmSuffix } = llm;
  if (!exact) return null;

  // Find all verbatim occurrences.
  const occurrences: number[] = [];
  let i = content.indexOf(exact);
  while (i !== -1) {
    occurrences.push(i);
    i = content.indexOf(exact, i + 1);
  }

  if (occurrences.length === 1) {
    const start = occurrences[0]!;
    const end = start + exact.length;
    const ctx = extractContext(content, start, end);
    return {
      start,
      end,
      exact,
      ...(ctx.prefix !== undefined ? { prefix: ctx.prefix } : {}),
      ...(ctx.suffix !== undefined ? { suffix: ctx.suffix } : {}),
      anchorMethod: 'unique-match',
    };
  }

  if (occurrences.length > 1) {
    // Disambiguate via LLM-emitted prefix/suffix when present. Use a small
    // window adjacent to each candidate — wider than the surrounding-text
    // window the LLM is asked to emit, so a prefix/suffix that's a few
    // chars shorter than ours still matches.
    if (llmPrefix || llmSuffix) {
      for (const pos of occurrences) {
        const candPrefix = content.substring(Math.max(0, pos - DISAMBIGUATION_CONTEXT), pos);
        const candSuffix = content.substring(
          pos + exact.length,
          Math.min(content.length, pos + exact.length + DISAMBIGUATION_CONTEXT),
        );
        const prefixOk = !llmPrefix || candPrefix.endsWith(llmPrefix) || candPrefix.includes(llmPrefix.trim());
        const suffixOk = !llmSuffix || candSuffix.startsWith(llmSuffix) || candSuffix.includes(llmSuffix.trim());
        if (prefixOk && suffixOk) {
          const start = pos;
          const end = start + exact.length;
          const ctx = extractContext(content, start, end);
          return {
            start,
            end,
            exact,
            ...(ctx.prefix !== undefined ? { prefix: ctx.prefix } : {}),
            ...(ctx.suffix !== undefined ? { suffix: ctx.suffix } : {}),
            anchorMethod: 'context-recovered',
          };
        }
      }
    }

    // No context match. Fall back to the first occurrence and flag for
    // audit. Without an LLM-emitted locality hint there's no better
    // signal at this stage; `first-of-many` callers should log loudly so
    // operators can correct misanchored annotations.
    const start = occurrences[0]!;
    const end = start + exact.length;
    const ctx = extractContext(content, start, end);
    return {
      start,
      end,
      exact,
      ...(ctx.prefix !== undefined ? { prefix: ctx.prefix } : {}),
      ...(ctx.suffix !== undefined ? { suffix: ctx.suffix } : {}),
      anchorMethod: 'first-of-many',
    };
  }

  // No verbatim occurrences. Try fuzzy match (case-insensitive,
  // whitespace-normalized, Levenshtein with 5% tolerance). No position
  // hint to bias the search — fuzzy match scans content globally.
  const cache = buildContentCache(content);
  const fuzzy = findBestTextMatch(content, exact, undefined, cache);
  if (!fuzzy) return null;

  const actual = content.substring(fuzzy.start, fuzzy.end);
  const ctx = extractContext(content, fuzzy.start, fuzzy.end);
  return {
    start: fuzzy.start,
    end: fuzzy.end,
    // Use the actual source text, not the LLM's version — the LLM may
    // have emitted slightly different characters (smart vs straight
    // quotes, etc.) and we store what's verifiable.
    exact: actual,
    ...(ctx.prefix !== undefined ? { prefix: ctx.prefix } : {}),
    ...(ctx.suffix !== undefined ? { suffix: ctx.suffix } : {}),
    anchorMethod: 'fuzzy-match',
    matchQuality: fuzzy.matchQuality,
  };
}
