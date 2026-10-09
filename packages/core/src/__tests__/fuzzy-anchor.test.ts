import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeText, normalizeTextWithMap, lowerCaseWithMap, findBestTextMatch, buildContentCache, type ContentCache } from '../fuzzy-anchor';
import { textOffsets } from '../text-offsets';

/** What is made once for a content, as a caller with many searches of it makes it. */
const cacheOf = (content: string): ContentCache => buildContentCache(content);

describe('Fuzzy Anchoring (W3C TextQuoteSelector)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('normalizeText', () => {
    it('should collapse whitespace', () => {
      expect(normalizeText('hello  world')).toBe('hello world');
      expect(normalizeText('hello\n\nworld')).toBe('hello world');
      expect(normalizeText('  hello  world  ')).toBe('hello world');
    });

    it('should convert curly quotes to straight quotes', () => {
      expect(normalizeText('\u2018hello\u2019')).toBe("'hello'"); // Single quotes
      expect(normalizeText('\u201Chello\u201D')).toBe('"hello"'); // Double quotes
    });

    it('should normalize dashes', () => {
      expect(normalizeText('hello\u2014world')).toBe('hello--world'); // Em-dash
      expect(normalizeText('hello\u2013world')).toBe('hello-world'); // En-dash
    });

    it('should handle combined transformations', () => {
      const input = '  "hello  world" — test  ';
      const expected = '"hello world" -- test';
      expect(normalizeText(input)).toBe(expected);
    });
  });

  describe('normalizeTextWithMap', () => {
    // The produced normalized string must always equal normalizeText —
    // they can't be allowed to drift, since findBestTextMatch's normalized
    // search uses one and its position mapping uses the other.
    const cases = [
      'hello world',
      'hello  world',
      'hello\n\nworld',
      '  leading and trailing  ',
      'Kenison, C.J.\nThe question for decision',
      'He said “hello world” yesterday',
      'an em — dash and an en – dash',
      'tabs\tand\nnewlines   collapsed',
      '',
      '   ',
    ];

    for (const input of cases) {
      it(`normalized output equals normalizeText for ${JSON.stringify(input)}`, () => {
        expect(normalizeTextWithMap(input).normalized).toBe(normalizeText(input));
      });
    }

    it('maps each normalized position back to the offset it came from', () => {
      const input = 'Kenison, C.J.\nThe question';
      const { normalized, map } = normalizeTextWithMap(input);
      // For every normalized char that is not the collapsed space, the
      // original char at the mapped index normalizes to the same char.
      for (let i = 0; i < normalized.length; i++) {
        const origIdx = map[i]!;
        const origChar = input[origIdx]!;
        const normChar = normalized[i]!;
        if (normChar === ' ') {
          // collapsed-space positions map to a whitespace original char
          expect(/\s/.test(origChar)).toBe(true);
        } else {
          expect(normalizeText(origChar)).toBe(normChar);
        }
      }
    });

    it('map has an entry for each character of the normalized text, and none for its end', () => {
      const input = 'abc def  ';
      const { normalized, map } = normalizeTextWithMap(input);
      expect(map).toHaveLength(normalized.length);
      expect(map[normalized.length - 1]).toBe(6);
    });

    it('maps offsets to offsets, both in code points: one entry for each code point of the normalized text', () => {
      // Eight code points: 😀 0, space 1, “ 2, a 3, ” 4, two spaces 5 and 6, b 7.
      // The normalized text is seven, though its string is eight units long.
      const { normalized, map } = normalizeTextWithMap('😀 “a”  b');
      expect(normalized).toBe('😀 "a" b');
      expect(map).toEqual([0, 1, 2, 3, 4, 5, 7]);
      expect(map).toHaveLength(textOffsets(normalized).length);
    });

    it('an em dash is two code points of the normalized text, both from the one dash', () => {
      const { normalized, map } = normalizeTextWithMap('a — b');
      expect(normalized).toBe('a -- b');
      expect(map).toEqual([0, 1, 2, 2, 3, 4]);
    });
  });

  describe('lowerCaseWithMap', () => {
    // The lower-cased text is the string's own, whole; the map is counted
    // from each character lower-cased alone. The two must be as long as one
    // another, or a match in the one is answered at the wrong place in the
    // other.
    const cases = [
      'The Quick Brown Fox',
      'İstanbul and ANKARA',
      'TAKSİ',
      'ΣΑΣ ΟΔΟΣ ΕΡΜΟΥ',
      '😀 İ 🎉 BIG ΣΑΣ.',
      'STRASSE straße ǅ',
      '',
    ];

    for (const input of cases) {
      it(`has an entry for each code point of the lower-cased ${JSON.stringify(input)}`, () => {
        const { lowered, map } = lowerCaseWithMap(input);
        expect(lowered).toBe(input.toLowerCase());
        expect(map).toHaveLength(textOffsets(lowered).length);
      });
    }

    it('maps each code point of the lower-cased text to the character it came from: U+0130 becomes two', () => {
      // a 0, İ 1, 😀 2, B 3. Lower-cased: a, i, a combining dot, 😀, b.
      const { lowered, map } = lowerCaseWithMap('aİ😀B');
      expect(lowered).toBe('ai\u0307😀b');
      expect(map).toEqual([0, 1, 1, 2, 3]);
    });

    it('lower-cases the text whole: a capital sigma that ends a word becomes the final one', () => {
      expect(lowerCaseWithMap('ΟΔΟΣ').lowered).toBe('οδος');
    });
  });

  describe('findBestTextMatch — normalized branch position mapping', () => {
    it('recovers the correct original offset despite whitespace before the match', () => {
      // Content has "Kenison, C.J.\nThe question…" where "The question"
      // starts at original index 14. The stored exact uses a straight quote
      // where the source has a smart quote, so verbatim fails and we go
      // through the normalized branch. The recovered offset must be 14 — not
      // 16, which a char-by-char walk yields by overshooting the 2 whitespace
      // runs before the match: the space after the comma and the newline.
      const content = 'Kenison, C.J.\nThe question for decision “foo” end';
      const search = 'The question for decision "foo"'; // straight quotes
      const result = findBestTextMatch(content, search, cacheOf(content));
      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('normalized');
      expect(result!.places).toHaveLength(1);
      const [place] = result!.places;
      expect(place!.start).toBe(14);
      // The recovered span, normalized, equals the normalized search.
      expect(normalizeText(content.substring(place!.start, place!.end))).toBe(normalizeText(search));
    });

    it('recovers correct offset when content has smart quotes and search has straight', () => {
      const content = 'Intro. He said “hello world” to everyone.';
      const search = '"hello world"';
      const result = findBestTextMatch(content, search, cacheOf(content));
      expect(result).not.toBeNull();
      const [place] = result!.places;
      expect(content.substring(place!.start, place!.end)).toBe('“hello world”');
    });

    it('ends a match just after its last character: white space the content has after it is no part of it', () => {
      const content = 'He said “hello world”  \n';
      expect(findBestTextMatch(content, '"hello world"', cacheOf(content)))
        .toEqual({ places: [{ start: 8, end: 21 }], matchQuality: 'normalized' });
    });

    it('finds no place for text that is empty or only white space: it is no words to find', () => {
      const content = 'Some content';
      expect(findBestTextMatch(content, ' \n\t', cacheOf(content))).toBeNull();
      expect(findBestTextMatch(content, '', cacheOf(content))).toBeNull();
      // Nor where the content has that white space, character for character.
      expect(findBestTextMatch(content, ' ', cacheOf(content))).toBeNull();
    });
  });

  describe('findBestTextMatch', () => {
    it('should find normalized match when exact fails', () => {
      const content = 'The quick  brown fox'; // Two spaces
      const result = findBestTextMatch(content, 'quick brown', cacheOf(content)); // One space

      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('normalized');
    });

    it('should find case-insensitive match when normalized fails', () => {
      const content = 'The Quick Brown Fox';
      const result = findBestTextMatch(content, 'quick brown', cacheOf(content));

      expect(result).toEqual({ places: [{ start: 4, end: 15 }], matchQuality: 'case-insensitive' });
    });

    it('answers every place the search that finds any finds it, in the content\'s order', () => {
      const content = 'The Cat and the  cat and THE CAT';
      expect(findBestTextMatch(content, 'the cat', cacheOf(content)))
        .toEqual({ places: [{ start: 12, end: 20 }], matchQuality: 'normalized' });
      expect(findBestTextMatch(content, 'tHE cAT', cacheOf(content)))
        .toEqual({ places: [{ start: 0, end: 7 }, { start: 25, end: 32 }], matchQuality: 'case-insensitive' });
    });

    it('should find a fuzzy match within a twentieth of the search text\'s length', () => {
      const content = 'The quick brown fox jumps over the lazy dog';
      const searchText = 'quick brvwn fox jumps'; // Typo: 'o' → 'v', in 21 code points
      const result = findBestTextMatch(content, searchText, cacheOf(content));

      expect(result).toEqual({ places: [{ start: 4, end: 25 }], matchQuality: 'fuzzy' });
    });

    it('should find a fuzzy match longer or shorter than the search text', () => {
      const content = 'The quick brown fox jumps over the lazy dog';
      // A letter dropped, and a letter added: the stretch found is the content's own words.
      expect(findBestTextMatch(content, 'quick brwn fox jumps', cacheOf(content)))
        .toEqual({ places: [{ start: 4, end: 25 }], matchQuality: 'fuzzy' });
      expect(findBestTextMatch(content, 'quick broown fox jumps', cacheOf(content)))
        .toEqual({ places: [{ start: 4, end: 25 }], matchQuality: 'fuzzy' });
    });

    it('allows a search text of fewer than twenty code points no edit', () => {
      const content = 'The quick brown fox jumps over the lazy dog';
      expect(findBestTextMatch(content, 'brvwn fox', cacheOf(content))).toBeNull();
    });

    it('should return null when no acceptable match found', () => {
      const content = 'The quick brown fox';
      const result = findBestTextMatch(content, 'lazy dog', cacheOf(content));

      expect(result).toBeNull();
    });
  });

  // What is answered are offsets: they count code points. After a character
  // outside the Basic Multilingual Plane an offset is less than the string's
  // own position.
  describe('findBestTextMatch — offsets count code points', () => {
    it('a normalized match after such a character is answered as offsets, through the map', () => {
      const content = '😀 The quick  brown fox';
      expect(findBestTextMatch(content, 'quick brown', cacheOf(content)))
        .toEqual({ places: [{ start: 6, end: 18 }], matchQuality: 'normalized' });
    });

    it('so is a case-insensitive match', () => {
      const content = '😀 The Quick Brown Fox';
      expect(findBestTextMatch(content, 'quick brown', cacheOf(content)))
        .toEqual({ places: [{ start: 6, end: 17 }], matchQuality: 'case-insensitive' });
    });

    it('so is a fuzzy match, and it is as long as its code points', () => {
      // 22 code points, 23 units of a string: one wrong letter is within a twentieth of 22.
      const content = '😀 The 🦊 quick brown fox jumps';
      expect(findBestTextMatch(content, '🦊 quick brvwn fox jump', cacheOf(content)))
        .toEqual({ places: [{ start: 6, end: 28 }], matchQuality: 'fuzzy' });
    });

    it('a normalized match of words that hold such a character ends where its code points do', () => {
      const content = '😀 The 🦊 quick  brown fox';
      expect(findBestTextMatch(content, '🦊 quick brown', cacheOf(content)))
        .toEqual({ places: [{ start: 6, end: 20 }], matchQuality: 'normalized' });
    });

    it('a match that ends or begins between the two code points a character became takes the character whole', () => {
      // İ lower-cases to an i and a combining dot. A plain i matches the first
      // of the two, a search text that begins with the dot the second.
      const taxi = 'a TAKSİ here';
      expect(findBestTextMatch(taxi, 'taksi', cacheOf(taxi)))
        .toEqual({ places: [{ start: 2, end: 7 }], matchQuality: 'case-insensitive' });
      const city = 'in İSTANBUL now';
      expect(findBestTextMatch(city, '\u0307stanbul', cacheOf(city)))
        .toEqual({ places: [{ start: 3, end: 11 }], matchQuality: 'case-insensitive' });
    });

    it('a case-insensitive match is a span of the content, not of the lower-cased content', () => {
      // İ lower-cases to two characters, so in the lower-cased string 😀 is
      // one further along: where the content's string has the middle of it.
      // In the content it is at offset 1, and the match ends at 6.
      const content = 'İ😀 BIG';
      expect(findBestTextMatch(content, '😀 big', cacheOf(content)))
        .toEqual({ places: [{ start: 1, end: 6 }], matchQuality: 'case-insensitive' });
    });
  });
});
