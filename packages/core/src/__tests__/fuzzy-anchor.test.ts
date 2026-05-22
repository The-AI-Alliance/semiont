import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyPosition, normalizeText, findBestTextMatch, buildContentCache } from '../fuzzy-anchor';

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
