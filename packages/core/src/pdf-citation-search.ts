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

/** Distinct break marker — deliberately not a space (spaces are never wildcards). */
const BREAK_MARKER = '';

/** Optional-break gap: the marker, with an optional space on either side. */
const BREAK_GAP = `(?: ?${BREAK_MARKER} ?)?`;

const escapeRegExp = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findClaimSpan(
  anchored: AnchoredText,
  exact: string,
): { start: number; end: number } | null {
  const needle = exact.replace(/\s+/g, ' ').trim();
  if (needle.length === 0) return null;

  // ── Stage 1: strict, over a whitespace-normalized copy with an offset map ──
  let norm = '';
  const map: number[] = [];
  let pendingWsAt = -1;
  for (let i = 0; i < anchored.text.length; i++) {
    const ch = anchored.text[i]!;
    if (/\s/.test(ch)) {
      if (norm.length > 0 && pendingWsAt < 0) pendingWsAt = i;
      continue;
    }
    if (pendingWsAt >= 0) {
      norm += ' ';
      map.push(pendingWsAt);
      pendingWsAt = -1;
    }
    norm += ch;
    map.push(i);
  }
  const idx = norm.indexOf(needle);
  if (idx >= 0) {
    return { start: map[idx]!, end: map[idx + needle.length - 1]! + 1 };
  }

  // ── Stage 2: break-aware, only on a miss ──
  const marker = anchored.text.replace(/\n/g, BREAK_MARKER);
  const pattern = [...needle].map(escapeRegExp).join(BREAK_GAP);
  const match = new RegExp(pattern).exec(marker);
  if (match) {
    return { start: match.index, end: match.index + match[0].length };
  }

  return null;
}
