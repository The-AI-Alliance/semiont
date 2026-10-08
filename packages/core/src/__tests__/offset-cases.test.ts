/**
 * What a text offset counts, held to specs/src/text/offset-cases.json: the
 * table every implementation that makes or applies an offset runs.
 *
 * A JavaScript string is indexed in UTF-16 code units. An offset on the wire
 * counts code points. `textOffsets` is the one place the two meet, and this
 * runs it both ways over every span of the table.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { textOffsets } from '../text-offsets';

interface Span { exact: string; occurrence: number; start: number; end: number }
interface Case { why: string; text: string; codePoints: number; spans: Span[] }

const TABLE = 'specs/src/text/offset-cases.json';
const table: { cases: Case[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../..', TABLE), 'utf8'));

/** Where the string holds the n-th occurrence of `exact`, in the string's own count. */
function found(text: string, exact: string, occurrence: number): number {
  let at = -1;
  for (let n = 0; n < occurrence; n++) {
    at = text.indexOf(exact, at + 1);
    if (at === -1) throw new Error(`"${text}" has no occurrence ${occurrence} of "${exact}"`);
  }
  return at;
}

describe('a text offset counts code points (specs/src/text/offset-cases.json)', () => {
  it('has cases, and one at least with a character outside the basic plane', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    expect(table.cases.some(({ text }) => /[\u{10000}-\u{10FFFF}]/u.test(text))).toBe(true);
  });

  describe.each(table.cases)('$why', ({ text, codePoints, spans }) => {
    const offsets = textOffsets(text);

    it('the text is as many code points as the table says', () => {
      expect(offsets.length).toBe(codePoints);
    });

    it.each(spans)('"$exact" ($occurrence): found in the string, it is given the table\'s offsets', ({ exact, occurrence, start, end }) => {
      const index = found(text, exact, occurrence);
      expect(offsets.offsetAt(index)).toBe(start);
      expect(offsets.offsetAt(index + exact.length)).toBe(end);
    });

    it.each(spans)('"$exact" ($occurrence): the table\'s offsets, taken into the string, are its words', ({ exact, start, end }) => {
      expect(text.slice(offsets.indexAt(start), offsets.indexAt(end))).toBe(exact);
    });
  });
});

// What only a string indexed in UTF-16 can get wrong, and so is no case of the
// table: a position that is not between two characters.
describe('what textOffsets refuses', () => {
  const offsets = textOffsets('a😀b');

  it('a position inside a character has no offset', () => {
    expect(() => offsets.offsetAt(2)).toThrow('position 2 is inside a character');
  });

  it.each([-1, 5, 1.5, Number.NaN])('a position the string does not have: %s', (index) => {
    expect(() => offsets.offsetAt(index)).toThrow(RangeError);
  });

  it.each([-1, 4, 0.5, Number.NaN])('an offset the text does not have: %s', (offset) => {
    expect(() => offsets.indexAt(offset)).toThrow(RangeError);
  });

  it('the end of the text is a position and an offset, each way', () => {
    expect(offsets.offsetAt(4)).toBe(3);
    expect(offsets.indexAt(3)).toBe(4);
  });

  it('half of a pair on its own is a code point: an ill-formed string is still counted', () => {
    const lone = textOffsets('a\ud83db');
    expect(lone.length).toBe(3);
    expect(lone.offsetAt(2)).toBe(2);
    expect(lone.indexAt(2)).toBe(2);
  });

  it('the empty text has one position, which is its end', () => {
    const empty = textOffsets('');
    expect(empty.length).toBe(0);
    expect(empty.offsetAt(0)).toBe(0);
    expect(empty.indexAt(0)).toBe(0);
  });
});
