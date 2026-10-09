/**
 * Where an offset into a text meets a JavaScript string.
 *
 * A text offset, on the wire, in the record and in every store, counts
 * Unicode code points from the start of the text: the W3C Web Annotation
 * rule, and the same count in every language. A JavaScript string is indexed
 * in UTF-16 code units, where a character outside the Basic Multilingual
 * Plane is two. The two counts agree until the first such character and
 * differ by one more after each.
 *
 * So arithmetic is done on offsets, and a length is a difference of two of
 * them: every count a rule states is of code points. A string's own position
 * is only ever the argument or the result of a call on the string (a slice, a
 * search, a regular expression's index), and is converted there.
 * specs/src/text/offset-cases.json holds the count, for this and for every
 * other implementation.
 */

/** A text's offsets and a string's positions, each given the other. */
export interface TextOffsets {
  /** How many code points the text is. An offset may equal it and may not exceed it. */
  readonly length: number;
  /** The offset of a position in the string: how many code points are before it. */
  offsetAt(index: number): number;
  /** The position in the string of an offset. */
  indexAt(offset: number): number;
}

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Whether the string has, at `index`, the two units of one character outside the basic plane. */
const isPairAt = (text: string, index: number): boolean =>
  isHigh(text.charCodeAt(index)) && isLow(text.charCodeAt(index + 1));

/** How many of `sorted` are less than `value`. */
function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The conversions for one text, made once and asked as often as the text has
 * offsets. Making it reads the text once; each conversion after that is a
 * search among the text's characters outside the basic plane, of which most
 * texts have none.
 *
 * Half of a pair on its own counts as a code point, as the string's own
 * iteration counts it: an ill-formed string is still a text with offsets.
 */
export function textOffsets(text: string): TextOffsets {
  /** The position of each character outside the basic plane: of the first unit of its pair. */
  const pairs: number[] = [];
  for (let index = 0; index < text.length - 1; index++) {
    if (isPairAt(text, index)) {
      pairs.push(index);
      index++;
    }
  }
  /** The offset of each of those characters: its position, less the pairs before it. */
  const pairOffsets = pairs.map((index, before) => index - before);
  const length = text.length - pairs.length;

  return {
    length,
    offsetAt(index: number): number {
      if (!Number.isInteger(index) || index < 0 || index > text.length) {
        throw new RangeError(`position ${index} is not in a string of ${text.length} units`);
      }
      // A pair that begins before `index` is wholly before it, or `index` is its second unit.
      const before = countBelow(pairs, index);
      if (before > 0 && pairs[before - 1]! + 1 === index) {
        throw new RangeError(`position ${index} is inside a character: it has no offset`);
      }
      return index - before;
    },
    indexAt(offset: number): number {
      if (!Number.isInteger(offset) || offset < 0 || offset > length) {
        throw new RangeError(`offset ${offset} is not in a text of ${length} code points`);
      }
      // Each character outside the basic plane before the offset is one more unit of the string.
      return offset + countBelow(pairOffsets, offset);
    },
  };
}

/**
 * Every place `text` has `words`, as the offset each starts at, in the text's
 * order. Places may overlap. `offsets` is the text's own.
 *
 * A string is searched by its code units, so a search for words that begin or
 * end with half of a pair also finds them inside a character of the text. The
 * text does not have those words there, character for character, and the
 * position has no offset: it is no place.
 */
export function occurrencesOf(text: string, offsets: TextOffsets, words: string): number[] {
  const places: number[] = [];
  let index = text.indexOf(words);
  while (index !== -1) {
    const end = index + words.length;
    if (!isPairAt(text, index - 1) && !isPairAt(text, end - 1)) places.push(offsets.offsetAt(index));
    // Words of no length are found at the end of the text too, and a search
    // from past the end finds them there again.
    index = index < text.length ? text.indexOf(words, index + 1) : -1;
  }
  return places;
}
