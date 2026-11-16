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
  | 'fast-path'
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
  position?: { start: number; end: number };
  quote?: { exact: string; prefix?: string; suffix?: string };
}

/**
 * Distance window for the position tiebreaker. Candidates closer than this
 * to the hint receive a non-zero position score; further candidates fall
 * back to zero. Tuned for typical document sizes; calibration tests pin
 * the boundary behaviour rather than the exact value.
 */
export const POSITION_WINDOW = 1024;

/**
 * Score weights — kept as named constants so the calibration tests can
 * import them and pin the *relationships* rather than the magnitudes.
 *
 * Invariant: a full-context match always outranks any position score.
 * (`CONTEXT_FULL_WEIGHT * 2 > POSITION_WEIGHT_MAX`, accounting for
 * prefix+suffix each contributing the full weight.)
 */
export const CONTEXT_FULL_WEIGHT = 10;
export const CONTEXT_PARTIAL_WEIGHT = 5;
export const POSITION_WEIGHT_MAX = 5;

/**
 * Locate the best-effort anchor for an annotation against the content the
 * renderer is about to display. Verbatim-only — see the module doc.
 */
export function anchorAnnotation(
  content: string,
  selectors: AnchorSelectors,
): RenderedAnchor | null {
  const { position, quote } = selectors;

  // No quote selector. Position is the only signal; use it verbatim if
  // present and in-range, otherwise the annotation has no anchor.
  if (!quote || !quote.exact) {
    if (!position) return null;
    if (position.start < 0 || position.end > content.length || position.start >= position.end) {
      return null;
    }
    return {
      start: position.start,
      end: position.end,
      strategy: 'position-fallback',
      confidence: 'low',
    };
  }

  const { exact, prefix, suffix } = quote;

  // Fast path: position hint exactly matches the exact text.
  if (position) {
    const probeEnd = position.start + exact.length;
    if (
      position.start >= 0 &&
      probeEnd <= content.length &&
      content.substring(position.start, probeEnd) === exact
    ) {
      return {
        start: position.start,
        end: probeEnd,
        strategy: 'fast-path',
        confidence: 'high',
      };
    }
  }

  // Find all occurrences via exact indexOf. Cheap; bounded by content
  // size; sufficient for the common case where the renderer's content
  // matches the worker's content character-for-character.
  const occurrences = findAllOccurrences(content, exact);

  if (occurrences.length === 1) {
    const start = occurrences[0]!;
    return {
      start,
      end: start + exact.length,
      strategy: 'unique-occurrence',
      confidence: 'high',
    };
  }

  if (occurrences.length > 1) {
    const winner = pickByScore(content, occurrences, exact, prefix, suffix, position?.start);
    return winner;
  }

  // No verbatim occurrence. We do NOT fuzzy-match at render time — a
  // non-verbatim mismatch means the content diverged or the record is
  // wrong, which is an upstream concern. Render at the stored offset so the
  // highlight still appears, flagged low-confidence so the discrepancy is
  // visible and gets corrected at the source.
  if (position && position.start >= 0 && position.end <= content.length && position.start < position.end) {
    return {
      start: position.start,
      end: position.end,
      strategy: 'position-fallback',
      confidence: 'low',
    };
  }

  return null;
}

function findAllOccurrences(content: string, exact: string): number[] {
  const out: number[] = [];
  let i = content.indexOf(exact);
  while (i !== -1) {
    out.push(i);
    i = content.indexOf(exact, i + 1);
  }
  return out;
}

/**
 * Context match score at a candidate offset.
 * Returns full / partial / no-match per side (prefix and suffix), then
 * sums each side weighted by `CONTEXT_FULL_WEIGHT` / `CONTEXT_PARTIAL_WEIGHT`.
 *
 * "Full" means the stored context aligns exactly with the source text
 * adjacent to the candidate. "Partial" is the looser substring check —
 * the stored context appears somewhere in the candidate's surroundings
 * but isn't anchored to the edges. This is the same partial-match logic
 * the previous `findTextWithContext` used, captured here so the scorer
 * can use it as one signal among many instead of a hard filter.
 */
function contextScoreAt(
  content: string,
  pos: number,
  exact: string,
  prefix: string | undefined,
  suffix: string | undefined,
): { score: number; full: boolean } {
  let score = 0;
  let prefixFull = true;
  let suffixFull = true;

  if (prefix) {
    const adj = content.substring(Math.max(0, pos - prefix.length), pos);
    if (adj.endsWith(prefix)) {
      score += CONTEXT_FULL_WEIGHT;
      prefixFull = true;
    } else if (adj.includes(prefix.trim()) && prefix.trim().length > 0) {
      score += CONTEXT_PARTIAL_WEIGHT;
      prefixFull = false;
    } else {
      prefixFull = false;
    }
  }

  if (suffix) {
    const adj = content.substring(pos + exact.length, Math.min(content.length, pos + exact.length + suffix.length));
    if (adj.startsWith(suffix)) {
      score += CONTEXT_FULL_WEIGHT;
      suffixFull = true;
    } else if (adj.includes(suffix.trim()) && suffix.trim().length > 0) {
      score += CONTEXT_PARTIAL_WEIGHT;
      suffixFull = false;
    } else {
      suffixFull = false;
    }
  }

  // "Full" overall match means every provided context field aligned
  // exactly — no partial fallbacks. Used to bump confidence to high.
  const full =
    (prefix === undefined || prefixFull) &&
    (suffix === undefined || suffixFull) &&
    (prefix !== undefined || suffix !== undefined);

  return { score, full };
}

function positionScoreAt(pos: number, hint: number | undefined): number {
  if (hint === undefined) return 0;
  const distance = Math.abs(pos - hint);
  if (distance >= POSITION_WINDOW) return 0;
  return POSITION_WEIGHT_MAX * (1 - distance / POSITION_WINDOW);
}

function pickByScore(
  content: string,
  occurrences: number[],
  exact: string,
  prefix: string | undefined,
  suffix: string | undefined,
  hint: number | undefined,
): RenderedAnchor {
  let bestPos = occurrences[0]!;
  let bestScore = -1;
  let bestContextFull = false;
  let bestHasAnyContextSignal = false;
  let bestHasAnyPositionSignal = false;

  for (const pos of occurrences) {
    const ctx = contextScoreAt(content, pos, exact, prefix, suffix);
    const positionScore = positionScoreAt(pos, hint);
    const total = ctx.score + positionScore;
    if (total > bestScore) {
      bestScore = total;
      bestPos = pos;
      bestContextFull = ctx.full;
      bestHasAnyContextSignal = ctx.score > 0;
      bestHasAnyPositionSignal = positionScore > 0;
    }
  }

  // Strategy + confidence classification:
  //  - both context fields aligned exactly → high-confidence context-disambiguated
  //  - some context aligned (full or partial), no position needed → context-disambiguated, medium
  //  - position broke the tie (winning candidate has position signal but no context signal,
  //    or context was equal across candidates) → position-tiebreaker
  //  - no signal at all (all candidates scored zero) → position-tiebreaker, low confidence,
  //    deterministic first-of-many fallback
  let strategy: AnchorStrategy;
  let confidence: AnchorConfidence;

  if (bestContextFull) {
    strategy = 'context-disambiguated';
    confidence = 'high';
  } else if (bestHasAnyContextSignal && !bestHasAnyPositionSignal) {
    strategy = 'context-disambiguated';
    confidence = 'medium';
  } else if (bestHasAnyContextSignal && bestHasAnyPositionSignal) {
    // Context partially matched and position helped break the tie.
    strategy = 'position-tiebreaker';
    confidence = 'medium';
  } else if (bestHasAnyPositionSignal) {
    strategy = 'position-tiebreaker';
    confidence = 'medium';
  } else {
    strategy = 'position-tiebreaker';
    confidence = 'low';
  }

  return {
    start: bestPos,
    end: bestPos + exact.length,
    strategy,
    confidence,
  };
}
