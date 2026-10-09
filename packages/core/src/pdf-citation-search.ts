/**
 * Two-stage citation search over an extracted PDF text layer.
 *
 * A citation's `exact` claim text comes from the authored source; the rendered
 * text layer diverges from it in exactly two ways, measured on Typst output:
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
import { occurrencesOf, textOffsets, type TextOffsets } from './text-offsets';

/** Distinct break marker — deliberately not a space (spaces are never wildcards). */
const BREAK_MARKER = '';

/** Optional-break gap: the marker, with an optional space on either side. */
const BREAK_GAP = `(?: ?${BREAK_MARKER} ?)?`;

const escapeRegExp = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where `anchored.text` has the claim `exact`, or `null`.
 *
 * `start` and `end` are offsets into `anchored.text`: they count code points,
 * as its items' own offsets do, and are a string's positions only in a text
 * with no character outside the Basic Multilingual Plane.
 *
 * `offsets` is that text's own (`textOffsets(anchored.text)`): a caller with
 * several claims to find in one text makes it once.
 */
export function findClaimSpan(
  anchored: AnchoredText,
  offsets: TextOffsets,
  exact: string,
): { start: number; end: number } | null {
  const needle = exact.replace(/\s+/g, ' ').trim();
  if (needle.length === 0) return null;

  // ── Stage 1: strict, over a whitespace-normalized copy with an offset map ──
  // `map[i]` is the offset, in the text, of the character that the code
  // point at offset `i` of `norm` came from.
  let norm = '';
  const map: number[] = [];
  let pendingWsAt = -1;
  // The offset of `ch`: how many code points of the text are before it. The
  // text is walked a code point at a time, so it is one more for each.
  let offset = 0;
  for (const ch of anchored.text) {
    if (/\s/.test(ch)) {
      if (norm.length > 0 && pendingWsAt < 0) pendingWsAt = offset;
    } else {
      if (pendingWsAt >= 0) {
        norm += ' ';
        map.push(pendingWsAt);
        pendingWsAt = -1;
      }
      norm += ch;
      map.push(offset);
    }
    offset++;
  }
  const [found] = occurrencesOf(norm, textOffsets(norm), needle);
  if (found !== undefined) {
    // From the first matched character to just after the last.
    return { start: map[found]!, end: map[found + textOffsets(needle).length - 1]! + 1 };
  }

  // ── Stage 2: break-aware, only on a miss ──
  // The marked copy has one character where the text has another, so a
  // position in it is the same position in the text. The pattern is matched
  // a code point at a time (`u`), as it is built: a match is never inside a
  // character.
  const marker = anchored.text.replace(/\n/g, BREAK_MARKER);
  const pattern = [...needle].map(escapeRegExp).join(BREAK_GAP);
  const match = new RegExp(pattern, 'u').exec(marker);
  if (match) {
    return { start: offsets.offsetAt(match.index), end: offsets.offsetAt(match.index + match[0].length) };
  }

  return null;
}
