/**
 * Selector reconciliation for write-time annotation construction.
 *
 * LLM-produced text offsets are guides, not authoritative anchors.
 * `reconcileSelector` takes whatever the LLM emitted and produces a
 * `TextQuoteSelector`-equivalent `start`/`end`/`exact`/`prefix`/`suffix`
 * that is provably consistent with the source content:
 *
 *   - the text from `start` to `end` is `exact`
 *   - the text that ends at `start` is `prefix`
 *   - the text that starts at `end` is `suffix`
 *
 * `start` and `end` are offsets: they count Unicode code points from the
 * start of the content, and so does every length here (the 64 and the 32 of
 * the context, the window a hint is looked for in). They are a string's own
 * positions only in a text with no character outside the Basic Multilingual
 * Plane; a caller that slices a string converts them with `textOffsets`.
 * specs/src/annotations/reconcile-cases.json holds the rule.
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
import { occurrencesOf, textOffsets, type TextOffsets } from './text-offsets';

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
  /** The offset the span starts at: how many code points of the content are before it. */
  start: number;
  /** The offset just after the span. */
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

// Code points, all three.
const CONTEXT_LENGTH = 64;
const MAX_EXTENSION = 32;
// Minimum window of source text compared against an LLM-emitted prefix/suffix
// when disambiguating multiple occurrences. The actual window grows to the
// length of the LLM's prefix/suffix when that's longer — the prompts invite
// up to 64 code points, and a fixed window of 32 can't `endsWith`/`includes`
// a string of 64, which would silently defeat disambiguation for exactly the
// long, distinctive contexts that disambiguate best.
const DISAMBIGUATION_MIN_WINDOW = 32;

/** What a context is not lengthened past: white space, or one of eighteen marks. */
const BOUNDARY = /[\s.,;:!?'"()\[\]{}<>\/\\]/;

/**
 * The text between two offsets. An offset past the end of the text is its
 * end, as a string's own `substring` has it: `findBestTextMatch` can answer a
 * span that runs past the end, since its case-insensitive search takes a
 * position in the lower-cased text for one in the text, and past the end
 * there is nothing.
 */
function between(content: string, offsets: TextOffsets, start: number, end: number): string {
  return content.substring(
    offsets.indexAt(Math.min(start, offsets.length)),
    offsets.indexAt(Math.min(end, offsets.length)),
  );
}

/**
 * Extract prefix and suffix context for a `TextQuoteSelector` from
 * source content. Used internally by `reconcileSelector` after offsets
 * are reconciled, and exported for callers (e.g. UI-side selection
 * capture) that need the same extraction semantics.
 *
 * Extracts up to 64 code points before and after the selected text,
 * extending by up to 32 more to reach a word boundary so the
 * prefix/suffix is meaningful context rather than mid-word fragments.
 *
 * `start` and `end` are offsets: they count code points from the start of
 * `content`.
 */
export function extractContext(
  content: string,
  start: number,
  end: number,
): { prefix?: string; suffix?: string } {
  return contextOf(content, textOffsets(content), start, end);
}

/** `extractContext`, given the content's conversions: a caller with several spans of one content makes them once. */
function contextOf(
  content: string,
  offsets: TextOffsets,
  start: number,
  end: number,
): { prefix?: string; suffix?: string } {
  const result: { prefix?: string; suffix?: string } = {};

  if (start > 0) {
    let prefixStart = Math.max(0, start - CONTEXT_LENGTH);
    let extensionCount = 0;
    while (prefixStart > 0 && extensionCount < MAX_EXTENSION) {
      // The character before the prefix: none, when that is past the end of the text.
      const char = between(content, offsets, prefixStart - 1, prefixStart);
      if (!char || BOUNDARY.test(char)) break;
      prefixStart--;
      extensionCount++;
    }
    result.prefix = between(content, offsets, prefixStart, start);
  }

  if (end < offsets.length) {
    let suffixEnd = Math.min(offsets.length, end + CONTEXT_LENGTH);
    let extensionCount = 0;
    while (suffixEnd < offsets.length && extensionCount < MAX_EXTENSION) {
      if (BOUNDARY.test(between(content, offsets, suffixEnd, suffixEnd + 1))) break;
      suffixEnd++;
      extensionCount++;
    }
    result.suffix = between(content, offsets, end, suffixEnd);
  }

  return result;
}

/**
 * Reconcile LLM-emitted offsets against the source. Returns a selector
 * whose `start`/`end` are verified to bracket `exact` in `content`, and
 * whose `prefix`/`suffix` are extracted from source — never carried
 * verbatim from the LLM. `start` and `end` are offsets: they count code
 * points from the start of `content`.
 *
 * `offsets` is the content's own (`textOffsets(content)`): a caller with
 * several proposals over one content makes it once.
 *
 * Returns `null` if `exact` cannot be found anywhere in the content,
 * even via fuzzy match. Callers filter null and log the drop.
 */
export function reconcileSelector(
  content: string,
  offsets: TextOffsets,
  llm: LlmSelectorInput,
): ReconciledSelector | null {
  const { exact, prefix: llmPrefix, suffix: llmSuffix } = llm;
  if (!exact) return null;

  // How many code points `exact` is: a place it is found at ends this far on.
  const length = textOffsets(exact).length;

  /** The selector for `exact` found at the offset `start`. */
  const foundAt = (start: number, anchorMethod: AnchorMethod): ReconciledSelector => {
    const end = start + length;
    const ctx = contextOf(content, offsets, start, end);
    return {
      start,
      end,
      exact,
      ...(ctx.prefix !== undefined ? { prefix: ctx.prefix } : {}),
      ...(ctx.suffix !== undefined ? { suffix: ctx.suffix } : {}),
      anchorMethod,
    };
  };

  // Find all verbatim occurrences.
  const occurrences = occurrencesOf(content, offsets, exact);

  if (occurrences.length === 1) {
    return foundAt(occurrences[0]!, 'unique-match');
  }

  if (occurrences.length > 1) {
    // Disambiguate via LLM-emitted prefix/suffix when present. Size the
    // comparison window to the LLM's prefix/suffix (with a floor), so a
    // prefix of 64 code points is matched against at least 64 of source — a
    // fixed smaller window can't `endsWith`/`includes` a longer LLM string.
    if (llmPrefix || llmSuffix) {
      const prefixWindow = Math.max(DISAMBIGUATION_MIN_WINDOW, llmPrefix === undefined ? 0 : textOffsets(llmPrefix).length);
      const suffixWindow = Math.max(DISAMBIGUATION_MIN_WINDOW, llmSuffix === undefined ? 0 : textOffsets(llmSuffix).length);
      for (const pos of occurrences) {
        const candPrefix = between(content, offsets, Math.max(0, pos - prefixWindow), pos);
        const candSuffix = between(content, offsets, pos + length, pos + length + suffixWindow);
        const prefixOk = !llmPrefix || candPrefix.endsWith(llmPrefix) || candPrefix.includes(llmPrefix.trim());
        const suffixOk = !llmSuffix || candSuffix.startsWith(llmSuffix) || candSuffix.includes(llmSuffix.trim());
        if (prefixOk && suffixOk) {
          return foundAt(pos, 'context-recovered');
        }
      }
    }

    // No context match. Fall back to the first occurrence and flag for
    // audit. Without an LLM-emitted locality hint there's no better
    // signal at this stage; `first-of-many` callers should log loudly so
    // operators can correct misanchored annotations.
    return foundAt(occurrences[0]!, 'first-of-many');
  }

  // No verbatim occurrences. Try fuzzy match (case-insensitive,
  // whitespace-normalized, Levenshtein with 5% tolerance). No position
  // hint to bias the search — fuzzy match scans content globally.
  const cache = buildContentCache(content, offsets);
  const fuzzy = findBestTextMatch(content, exact, undefined, cache);
  if (!fuzzy) return null;

  const actual = between(content, offsets, fuzzy.start, fuzzy.end);
  const ctx = contextOf(content, offsets, fuzzy.start, fuzzy.end);
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
