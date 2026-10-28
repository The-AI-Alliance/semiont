/**
 * Fuzzy Anchoring for W3C Web Annotation TextQuoteSelector
 *
 * The searches a quote is put through when a text does not have it character
 * for character: without regard to white space and to the form of quotation
 * marks and dashes, without regard to letter case, and by edit distance.
 * specs/src/annotations/reconcile-cases.json holds the rule.
 *
 * A position in a text is an offset: it counts Unicode code points from the
 * start of the text, and so does every length a rule here states (the
 * stretch a quote is compared with, its allowance, an edit). A string's own
 * positions are converted with `textOffsets`, where the string is called.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */

import { occurrencesOf, textOffsets, type TextOffsets } from './text-offsets';

export type MatchQuality = 'normalized' | 'case-insensitive' | 'fuzzy';

/**
 * Normalize text for comparison - handles common document editing changes
 *
 * Collapses whitespace, converts curly quotes to straight quotes,
 * and normalizes common punctuation variations.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ')              // collapse whitespace
    .replace(/[\u2018\u2019]/g, "'")   // curly single quotes → straight
    .replace(/[\u201C\u201D]/g, '"')   // curly double quotes → straight
    .replace(/\u2014/g, '--')          // em-dash → double hyphen
    .replace(/\u2013/g, '-')           // en-dash → hyphen
    .trim();
}

/**
 * The edit distance between `wanted` and every stretch of `text` that starts
 * at `from`, up to one of `longest` code points: `distances[n]` is the least
 * number of single code points inserted, deleted or replaced that turns
 * `wanted` into the `n` code points from `from`. `null` when no stretch from
 * there is within `allowance`.
 *
 * Both are code points, one to an element, so an edit is of one code point.
 */
function distancesFrom(
  wanted: readonly string[],
  text: readonly string[],
  from: number,
  longest: number,
  allowance: number,
): number[] | null {
  // From none of `wanted`, a stretch of `n` code points is `n` insertions away.
  let row = Array.from({ length: longest + 1 }, (_, n) => n);
  let next = new Array<number>(longest + 1);

  for (let i = 1; i <= wanted.length; i++) {
    next[0] = i;
    let least = i;
    for (let n = 1; n <= longest; n++) {
      const cost = wanted[i - 1] === text[from + n - 1] ? 0 : 1;
      const distance = Math.min(row[n]! + 1, next[n - 1]! + 1, row[n - 1]! + cost);
      next[n] = distance;
      if (distance < least) least = distance;
    }
    // The least distance of a row never falls as more of `wanted` is taken.
    if (least > allowance) return null;
    [row, next] = [next, row];
  }

  return row;
}

/**
 * Pre-computed content strings for batch fuzzy matching.
 * Avoids recomputing normalizeText(content) and content.toLowerCase()
 * for every annotation when processing many annotations against the same content.
 *
 * `normalizedMap[i]` is the offset, in the original content, of the
 * character that the code point at offset `i` of `normalizedContent` came
 * from, and `lowerMap[i]` the same for `lowerContent`: an entry for each code
 * point of the changed copy. A map is how `findBestTextMatch` answers a match
 * in a copy as a span of the content itself. For the normalized copy,
 * counting char-by-char with `normalizeText(singleChar)` is wrong, because a
 * lone whitespace char trims to `''` (contributing 0) while in a full-string
 * normalize it collapses to a single space (contributing 1). That discrepancy
 * shifts recovered offsets by the number of whitespace runs before the match.
 */
export interface ContentCache {
  normalizedContent: string;
  /** The normalized content's own conversions: it is another string. */
  normalizedOffsets: TextOffsets;
  normalizedMap: number[];
  lowerContent: string;
  /** The lower-cased content's own conversions: it is another string, of another length where lower-casing changes one. */
  lowerOffsets: TextOffsets;
  lowerMap: number[];
}

/**
 * Normalize text and, in the same pass, build a map from each offset of the
 * normalized text back to the offset, in the input, of the character it
 * came from. Both count code points: the map has one entry for each code
 * point of the normalized text.
 * The produced `normalized` string is identical to `normalizeText(input)`
 * — a test pins this equivalence so the two can't drift.
 */
export function normalizeTextWithMap(input: string): { normalized: string; map: number[] } {
  let normalized = '';
  const map: number[] = [];

  // First pass mirrors normalizeText exactly, char by char, recording the
  // origin offset for every emitted normalized character.
  let pendingWhitespaceStart = -1; // origin offset of an open whitespace run, or -1

  const flushWhitespace = () => {
    if (pendingWhitespaceStart !== -1) {
      // A whitespace run collapses to a single space, mapped to the run's
      // first char — but a *leading* run (nothing emitted yet) is dropped,
      // matching normalizeText's trailing `.trim()`.
      if (normalized.length > 0) {
        normalized += ' ';
        map.push(pendingWhitespaceStart);
      }
      pendingWhitespaceStart = -1;
    }
  };

  // The offset of `ch`: how many code points of `input` are before it. A
  // string is walked a code point at a time, so it is one more for each.
  let offset = 0;
  for (const ch of input) {
    if (/\s/.test(ch)) {
      if (pendingWhitespaceStart === -1) pendingWhitespaceStart = offset;
      offset++;
      continue;
    }
    flushWhitespace();
    if (ch === '‘' || ch === '’') {
      normalized += "'"; map.push(offset);
    } else if (ch === '“' || ch === '”') {
      normalized += '"'; map.push(offset);
    } else if (ch === '—') {
      normalized += '--'; map.push(offset); map.push(offset);
    } else if (ch === '–') {
      normalized += '-'; map.push(offset);
    } else {
      normalized += ch; map.push(offset);
    }
    offset++;
  }
  // A trailing whitespace run is dropped by trim — do not flush it.

  // `normalizeText` applies `.trim()` last. Our run logic already drops a
  // trailing whitespace run; a leading run is dropped because flushWhitespace
  // only runs before a non-space char, so a run at the very start is never
  // emitted. Both ends match trim().
  return { normalized, map };
}

/**
 * Lower-case text and build a map from each offset of the lower-cased text
 * back to the offset, in the input, of the character it came from. Both
 * count code points.
 *
 * The text is lower-cased whole, by Unicode's rule of no particular language:
 * a capital sigma that ends a word becomes the final one, which lower-casing
 * a character at a time would miss. A character becomes as many code points
 * whole as alone (U+0130, a capital I with a dot, becomes two), which is what
 * the map is counted from.
 */
export function lowerCaseWithMap(input: string): { lowered: string; map: number[] } {
  const lowered = input.toLowerCase();
  const map: number[] = [];
  let offset = 0;
  for (const ch of input) {
    const codePoints = Array.from(ch.toLowerCase()).length;
    for (let n = 0; n < codePoints; n++) map.push(offset);
    offset++;
  }
  if (map.length !== textOffsets(lowered).length) {
    throw new Error('a text lower-cased whole is not as long as its characters lower-cased one at a time');
  }
  return { lowered, map };
}

/**
 * Build a ContentCache for a given content string.
 * Call once per content, pass to findBestTextMatch for every search of it.
 */
export function buildContentCache(content: string): ContentCache {
  const { normalized, map } = normalizeTextWithMap(content);
  const { lowered, map: lowerMap } = lowerCaseWithMap(content);
  return {
    normalizedContent: normalized,
    normalizedOffsets: textOffsets(normalized),
    normalizedMap: map,
    lowerContent: lowered,
    lowerOffsets: textOffsets(lowered),
    lowerMap,
  };
}

/**
 * The span of the content that a match in a changed copy of it came from:
 * `length` code points of the copy from the offset `at`. It starts at the
 * character the match's first code point came from and ends just after the
 * character its last came from, so a character that became several code
 * points is in the span whole, and white space the content has after the
 * match is not in it.
 */
function spanOf(map: readonly number[], at: number, length: number): { start: number; end: number } {
  return { start: map[at]!, end: map[at + length - 1]! + 1 };
}

/**
 * Find text that the content does not have character for character, using
 * multi-strategy search: the strictest of the looser searches that finds it
 * at all answers, with every place it finds it.
 *
 * The search `reconcile` (write-time) falls back on, having looked for the
 * text as it is.
 *
 * @param content - Full text content to search within
 * @param searchText - The text to find
 * @param cache - What is made once for the content (from buildContentCache)
 * @returns The places found, each two offsets in code points, in the content's order, and the search that found them; or null if none did
 */
export function findBestTextMatch(
  content: string,
  searchText: string,
  cache: ContentCache
): { places: Array<{ start: number; end: number }>; matchQuality: MatchQuality } | null {
  // Nothing, or only white space, is no words to find: it is in no place.
  if (searchText.trim() === '') return null;

  // Strategy 1: Normalized match (handles whitespace/quote variations).
  // Each place in the normalized content is answered as the span of the
  // content it came from, through the precomputed offset map.
  const normalizedSearch = normalizeText(searchText);
  const normalizedLength = textOffsets(normalizedSearch).length;
  const normalized = occurrencesOf(cache.normalizedContent, cache.normalizedOffsets, normalizedSearch);
  if (normalized.length > 0) {
    return {
      places: normalized.map((at) => spanOf(cache.normalizedMap, at, normalizedLength)),
      matchQuality: 'normalized'
    };
  }

  // Strategy 2: Case-insensitive match. Each place in the lower-cased
  // content is answered as the span of the content it came from: lower-casing
  // changes how many code points some characters are.
  const lowerSearch = searchText.toLowerCase();
  const lowerLength = textOffsets(lowerSearch).length;
  const lowered = occurrencesOf(cache.lowerContent, cache.lowerOffsets, lowerSearch);
  if (lowered.length > 0) {
    return {
      places: lowered.map((at) => spanOf(cache.lowerMap, at, lowerLength)),
      matchQuality: 'case-insensitive'
    };
  }

  // Strategy 3: Fuzzy match by edit distance, over every stretch of the
  // content. The search text is a code point to an element: its length is a
  // count of code points, and so is the stretch of content it is compared
  // with. The allowance is a twentieth of that length, with no minimum.
  const wanted = Array.from(searchText);
  const allowance = Math.floor(wanted.length / 20);
  // A stretch at no distance is the search text itself, which the content does not have.
  if (allowance === 0) return null;

  const text = Array.from(content);
  // A stretch within the allowance is at most the allowance shorter or longer than the search text.
  const shortest = wanted.length - allowance;
  let best: { start: number; end: number; distance: number } | null = null;

  // Of several stretches at the least distance, the one that starts first is
  // taken; of those from one start, the one nearest the search text in
  // length; and of two as near, the shorter. So from each start the stretch as
  // long as the search text is tried first, then the one a code point shorter
  // and the one a code point longer, and so on out.
  for (let start = 0; start + shortest <= text.length; start++) {
    const longest = Math.min(wanted.length + allowance, text.length - start);
    const distances = distancesFrom(wanted, text, start, longest, allowance);
    if (distances === null) continue;
    for (let away = 0; away <= allowance; away++) {
      for (const length of away === 0 ? [wanted.length] : [wanted.length - away, wanted.length + away]) {
        if (length > longest) continue;
        const distance = distances[length]!;
        if (distance <= allowance && (best === null || distance < best.distance)) {
          best = { start, end: start + length, distance };
        }
      }
    }
  }

  if (best === null) return null;
  return {
    places: [{ start: best.start, end: best.end }],
    matchQuality: 'fuzzy'
  };
}
