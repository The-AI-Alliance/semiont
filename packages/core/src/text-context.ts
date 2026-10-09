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
 * Returns `null` when the LLM emitted nothing but white space, or text that
 * doesn't appear in the source. Callers filter; the helper doesn't decide for
 * them.
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
  /** Exact text not found verbatim; a looser search recovered it, `matchQuality` naming which. */
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

/** A span of the source, as two offsets: from `start` up to but not including `end`. */
interface Place {
  start: number;
  end: number;
}

// Code points, all three.
const CONTEXT_LENGTH = 64;
const MAX_EXTENSION = 32;
// Minimum window of source text compared against an LLM-emitted prefix/suffix
// when choosing among several places. The actual window grows to the
// length of the LLM's prefix/suffix when that's longer — the prompts invite
// up to 64 code points, and a fixed window of 32 can't `endsWith`/`includes`
// a string of 64, which would silently defeat disambiguation for exactly the
// long, distinctive contexts that disambiguate best.
const DISAMBIGUATION_MIN_WINDOW = 32;

/** What a context is not lengthened past: white space, or one of eighteen marks. */
const BOUNDARY = /[\s.,;:!?'"()\[\]{}<>\/\\]/;

/** The text between two offsets. */
function between(content: string, offsets: TextOffsets, start: number, end: number): string {
  return content.substring(offsets.indexAt(start), offsets.indexAt(end));
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
      if (BOUNDARY.test(between(content, offsets, prefixStart - 1, prefixStart))) break;
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
 * Reconcile what the LLM quoted against the source. Returns a selector
 * whose `start`/`end` are verified to bracket `exact` in `content`, and
 * whose `exact`/`prefix`/`suffix` are extracted from source — never carried
 * verbatim from the LLM. `start` and `end` are offsets: they count code
 * points from the start of `content`.
 *
 * `offsets` is the content's own (`textOffsets(content)`): a caller with
 * several proposals over one content makes it once.
 *
 * Returns `null` if `exact` is empty or only white space, or cannot be found
 * anywhere in the content, even via fuzzy match. Callers filter null and log
 * the drop.
 */
export function reconcileSelector(
  content: string,
  offsets: TextOffsets,
  llm: LlmSelectorInput,
): ReconciledSelector | null {
  const { exact } = llm;
  // Nothing, or only white space, is no words to find.
  if (exact.trim() === '') return null;

  /** What the LLM said stands beside `exact`, when that is more than white space: a hint of where. */
  const hint = (given: string | undefined): string | undefined =>
    given === undefined || given.trim() === '' ? undefined : given;
  const prefixHint = hint(llm.prefix);
  const suffixHint = hint(llm.suffix);

  // Size the comparison window to the hint (with a floor), so a prefix of 64
  // code points is matched against at least 64 of source — a fixed smaller
  // window can't `endsWith`/`includes` a longer LLM string.
  const prefixWindow = Math.max(DISAMBIGUATION_MIN_WINDOW, prefixHint === undefined ? 0 : textOffsets(prefixHint).length);
  const suffixWindow = Math.max(DISAMBIGUATION_MIN_WINDOW, suffixHint === undefined ? 0 : textOffsets(suffixHint).length);

  /** Whether the source around a place carries every hint given. */
  const fits = ({ start, end }: Place): boolean => {
    const before = between(content, offsets, Math.max(0, start - prefixWindow), start);
    const after = between(content, offsets, end, Math.min(offsets.length, end + suffixWindow));
    const prefixOk = prefixHint === undefined || before.endsWith(prefixHint) || before.includes(prefixHint.trim());
    const suffixOk = suffixHint === undefined || after.startsWith(suffixHint) || after.includes(suffixHint.trim());
    return prefixOk && suffixOk;
  };

  /** The first of several places that the hints pick: none when no hint was given, or no place fits. */
  const hinted = (places: Place[]): Place | undefined =>
    prefixHint === undefined && suffixHint === undefined ? undefined : places.find(fits);

  /** A place as a selector has it: its text and its context are the source's own. */
  const quoteAt = ({ start, end }: Place): Pick<ReconciledSelector, 'start' | 'end' | 'exact' | 'prefix' | 'suffix'> => {
    const ctx = contextOf(content, offsets, start, end);
    return {
      start,
      end,
      // The source's text, not the LLM's version — the LLM may have emitted
      // slightly different characters (smart vs straight quotes, etc.) and
      // we store what's verifiable.
      exact: between(content, offsets, start, end),
      ...(ctx.prefix !== undefined ? { prefix: ctx.prefix } : {}),
      ...(ctx.suffix !== undefined ? { suffix: ctx.suffix } : {}),
    };
  };

  // Find all verbatim occurrences: a place each, as long as `exact` is in code points.
  const length = textOffsets(exact).length;
  const occurrences: Place[] = occurrencesOf(content, offsets, exact).map((start) => ({ start, end: start + length }));

  if (occurrences.length === 1) {
    return { ...quoteAt(occurrences[0]!), anchorMethod: 'unique-match' };
  }

  if (occurrences.length > 1) {
    const chosen = hinted(occurrences);
    if (chosen !== undefined) return { ...quoteAt(chosen), anchorMethod: 'context-recovered' };

    // No context match. Fall back to the first occurrence and flag for
    // audit. Without an LLM-emitted locality hint there's no better
    // signal at this stage; `first-of-many` callers should log loudly so
    // operators can correct misanchored annotations.
    return { ...quoteAt(occurrences[0]!), anchorMethod: 'first-of-many' };
  }

  // No verbatim occurrences. Try the looser searches (whitespace-normalized,
  // case-insensitive, edit distance within 5% of the length). Of several
  // places one of them finds, the hints choose as they do among verbatim
  // ones, and the first is taken when they choose none.
  const found = findBestTextMatch(content, exact, buildContentCache(content));
  if (!found) return null;
  return {
    ...quoteAt(hinted(found.places) ?? found.places[0]!),
    anchorMethod: 'fuzzy-match',
    matchQuality: found.matchQuality,
  };
}
