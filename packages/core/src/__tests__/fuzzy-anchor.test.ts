import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyPosition, normalizeText, normalizeTextWithMap, findBestTextMatch, buildContentCache } from '../fuzzy-anchor';

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

    it('maps each normalized position back to a correct original index', () => {
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
  });

  describe('findBestTextMatch — normalized branch position mapping', () => {
    it('recovers the correct original offset despite whitespace before the match', () => {
      // The motivating bug: content has "Kenison, C.J.\nThe question…" where
      // "The question" starts at original index 14. The stored exact uses a
      // straight quote where the source has a smart quote, so verbatim fails
      // and we go through the normalized branch. The recovered offset must
      // be 14 — not 16 (the old char-walk overshot by the 2 whitespace runs
      // before the match: the space after the comma and the newline).
      const content = 'Kenison, C.J.\nThe question for decision “foo” end';
      const search = 'The question for decision "foo"'; // straight quotes
      const result = findBestTextMatch(content, search, undefined, buildContentCache(content));
      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('normalized');
      expect(result!.start).toBe(14);
      // The recovered span, normalized, equals the normalized search.
      expect(normalizeText(content.substring(result!.start, result!.end))).toBe(normalizeText(search));
    });

    it('recovers correct offset when content has smart quotes and search has straight', () => {
      const content = 'Intro. He said “hello world” to everyone.';
      const search = '"hello world"';
      const result = findBestTextMatch(content, search, undefined, buildContentCache(content));
      expect(result).not.toBeNull();
      expect(content.substring(result!.start, result!.end)).toBe('“hello world”');
    });
  });

  describe('findBestTextMatch', () => {
    it('should find exact match first', () => {
      const content = 'The quick brown fox';
      const result = findBestTextMatch(content, 'brown fox', undefined, buildContentCache(content));

      expect(result).toEqual({ start: 10, end: 19, matchQuality: 'exact' });
    });

    it('should find normalized match when exact fails', () => {
      const content = 'The quick  brown fox'; // Two spaces
      const result = findBestTextMatch(content, 'quick brown', undefined, buildContentCache(content)); // One space

      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('normalized');
    });

    it('should find case-insensitive match when normalized fails', () => {
      const content = 'The Quick Brown Fox';
      const result = findBestTextMatch(content, 'quick brown', undefined, buildContentCache(content));

      expect(result).toEqual({ start: 4, end: 15, matchQuality: 'case-insensitive' });
    });

    it('should use position hint for fuzzy search', () => {
      const content = 'The quick brown fox jumps over the lazy dog';
      const searchText = 'brvwn fox'; // Typo: 'o' → 'v'
      const result = findBestTextMatch(content, searchText, 10, buildContentCache(content)); // Hint near actual position

      expect(result).not.toBeNull();
      expect(result!.matchQuality).toBe('fuzzy');
      expect(result!.start).toBe(10); // Should find "brown fox" despite typo
    });

    it('should return null when no acceptable match found', () => {
      const content = 'The quick brown fox';
      const result = findBestTextMatch(content, 'lazy dog', undefined, buildContentCache(content));

      expect(result).toBeNull();
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
