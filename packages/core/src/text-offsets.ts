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
 * So an offset is converted exactly where it enters or leaves a string, and
 * nowhere else: code that searches, slices and measures a string goes on
 * doing so in the string's own positions. specs/src/text/offset-cases.json
 * holds the count, for this and for every other implementation.
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
    if (isHigh(text.charCodeAt(index)) && isLow(text.charCodeAt(index + 1))) {
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
