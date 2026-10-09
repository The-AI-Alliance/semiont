import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyPosition, normalizeText, normalizeTextWithMap, findBestTextMatch, buildContentCache, type ContentCache } from '../fuzzy-anchor';
import { textOffsets } from '../text-offsets';

/** What is made once for a content, as a caller with many searches of it makes it. */
const cacheOf = (content: string): ContentCache => buildContentCache(content, textOffsets(content));

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

    it('map has length normalized.length + 1 with a content-length sentinel', () => {
      const input = 'abc def';
      const { normalized, map } = normalizeTextWithMap(input);
      expect(map).toHaveLength(normalized.length + 1);
      expect(map[normalized.length]).toBe(input.length);
    });

    it('maps offsets to offsets, both in code points: one entry for each code point of the normalized text, and one for its end', () => {
      // Eight code points: 😀 0, space 1, “ 2, a 3, ” 4, two spaces 5 and 6, b 7.
      // The normalized text is seven, though its string is eight units long;
      // the sentinel is the input's length in code points.
      const { normalized, map } = normalizeTextWithMap('😀 “a”  b');
      expect(normalized).toBe('😀 "a" b');
      expect(map).toEqual([0, 1, 2, 3, 4, 5, 7, 8]);
      expect(map).toHaveLength(textOffsets(normalized).length + 1);
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
      const result = findBestTextMatch(content, search, undefined, cacheOf(content));
      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('normalized');
      expect(result!.start).toBe(14);
      // The recovered span, normalized, equals the normalized search.
      expect(normalizeText(content.substring(result!.start, result!.end))).toBe(normalizeText(search));
    });

    it('recovers correct offset when content has smart quotes and search has straight', () => {
      const content = 'Intro. He said “hello world” to everyone.';
      const search = '"hello world"';
      const result = findBestTextMatch(content, search, undefined, cacheOf(content));
      expect(result).not.toBeNull();
      expect(content.substring(result!.start, result!.end)).toBe('“hello world”');
    });
  });

  describe('findBestTextMatch', () => {
    it('should find exact match first', () => {
      const content = 'The quick brown fox';
      const result = findBestTextMatch(content, 'brown fox', undefined, cacheOf(content));

      expect(result).toEqual({ start: 10, end: 19, matchQuality: 'exact' });
    });

    it('should find normalized match when exact fails', () => {
      const content = 'The quick  brown fox'; // Two spaces
      const result = findBestTextMatch(content, 'quick brown', undefined, cacheOf(content)); // One space

      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('normalized');
    });

    it('should find case-insensitive match when normalized fails', () => {
      const content = 'The Quick Brown Fox';
      const result = findBestTextMatch(content, 'quick brown', undefined, cacheOf(content));

      expect(result).toEqual({ start: 4, end: 15, matchQuality: 'case-insensitive' });
    });

    it('should use position hint for fuzzy search', () => {
      const content = 'The quick brown fox jumps over the lazy dog';
      const searchText = 'brvwn fox'; // Typo: 'o' → 'v'
      const result = findBestTextMatch(content, searchText, 10, cacheOf(content)); // Hint near actual position

      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('fuzzy');
      expect(result!.start).toBe(10); // Should find "brown fox" despite typo
    });

    it('should return null when no acceptable match found', () => {
      const content = 'The quick brown fox';
      const result = findBestTextMatch(content, 'lazy dog', undefined, cacheOf(content));

      expect(result).toBeNull();
    });
  });

  // What is answered, and what a hint is, are offsets: they count code
  // points. After a character outside the Basic Multilingual Plane an offset
  // is less than the string's own position.
  describe('findBestTextMatch — offsets count code points', () => {
    it('an exact match after such a character is answered as offsets', () => {
      const content = '😀 The quick brown fox';
      expect(findBestTextMatch(content, 'brown fox', undefined, cacheOf(content)))
        .toEqual({ start: 12, end: 21, matchQuality: 'exact' });
    });

    it('an exact match of words that hold such a character ends where its code points do', () => {
      const content = '😀 The 🦊 quick  brown fox';
      expect(findBestTextMatch(content, '🦊 quick', undefined, cacheOf(content)))
        .toEqual({ start: 6, end: 13, matchQuality: 'exact' });
    });

    it('so is a normalized match, through the map', () => {
      const content = '😀 The quick  brown fox';
      expect(findBestTextMatch(content, 'quick brown', undefined, cacheOf(content)))
        .toEqual({ start: 6, end: 18, matchQuality: 'normalized' });
    });

    it('so is a case-insensitive match', () => {
      const content = '😀 The Quick Brown Fox';
      expect(findBestTextMatch(content, 'quick brown', undefined, cacheOf(content)))
        .toEqual({ start: 6, end: 17, matchQuality: 'case-insensitive' });
    });

    it('the hint is an offset, and the stretch searched around it is of code points', () => {
      // "brown" is at offset 611: 600 characters outside the basic plane, a
      // space, and ten more. In the string it is at 1211, which 500 either
      // side of a hint of 611 does not reach.
      const content = `${'😀'.repeat(600)} The quick brown fox jumps`;
      expect(findBestTextMatch(content, 'brvwn fox', 611, cacheOf(content)))
        .toEqual({ start: 611, end: 620, matchQuality: 'fuzzy' });
    });

    it('a normalized match of words that hold such a character ends where its code points do', () => {
      const content = '😀 The 🦊 quick  brown fox';
      expect(findBestTextMatch(content, '🦊 quick brown', undefined, cacheOf(content)))
        .toEqual({ start: 6, end: 20, matchQuality: 'normalized' });
    });

    it('the lower-cased content is another string, converted by its own conversions', () => {
      // İ lower-cases to two characters, so in the lower-cased string 😀 is
      // one further along: where the content's string has the middle of it.
      const content = 'İ😀 BIG';
      expect(() => findBestTextMatch(content, '😀 big', undefined, cacheOf(content))).not.toThrow();
    });

    it('a hint past the end of the text finds nothing, and is no error', () => {
      const content = 'The quick brown fox';
      expect(findBestTextMatch(content, 'brvwn fox', 5000, cacheOf(content))).toBeNull();
    });
  });

  describe('verifyPosition', () => {
    it('should verify correct position', () => {
      const content = 'The quick brown fox';
      const position = { start: 10, end: 19 };
      const expectedExact = 'brown fox';

      const isValid = verifyPosition(content, position, expectedExact);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect position', () => {
      const content = 'The quick brown fox';
      const position = { start: 10, end: 15 };
      const expectedExact = 'brown fox';

      const isValid = verifyPosition(content, position, expectedExact);

      expect(isValid).toBe(false);
    });

    it('should reject position with wrong text', () => {
      const content = 'The quick brown fox';
      const position = { start: 10, end: 19 };
      const expectedExact = 'quick brown';

      const isValid = verifyPosition(content, position, expectedExact);

      expect(isValid).toBe(false);
    });
  });

  describe('verifyPosition — a position is two offsets', () => {
    it('counts code points', () => {
      // a 0, 😀 1, space 2, "brown fox" 3 to 12.
      expect(verifyPosition('a😀 brown fox', { start: 3, end: 12 }, 'brown fox')).toBe(true);
      expect(verifyPosition('a😀 brown fox', { start: 4, end: 13 }, 'brown fox')).toBe(false);
    });

    it('a position the text does not have points at nothing', () => {
      expect(verifyPosition('abc', { start: 1, end: 9 }, 'bc')).toBe(false);
      expect(verifyPosition('abc', { start: -1, end: 2 }, 'ab')).toBe(false);
      expect(verifyPosition('abc', { start: 0.5, end: 2 }, 'ab')).toBe(false);
      expect(verifyPosition('abc', { start: 2, end: 1 }, 'b')).toBe(false);
    });
  });

  describe('verifyPosition over multiple positions', () => {
    it('should verify each of several known positions', () => {
      const content = 'word word word';
      const exact = 'word';

      const positions = [
        { start: 0, end: 4 },
        { start: 5, end: 9 },
        { start: 10, end: 14 },
      ];

      positions.forEach(pos => {
        expect(verifyPosition(content, pos, exact)).toBe(true);
      });
    });
  });
});
