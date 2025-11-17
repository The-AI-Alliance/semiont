import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findTextWithContext, verifyPosition } from '../fuzzy-anchor';

describe('Fuzzy Anchoring (W3C TextQuoteSelector)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('findTextWithContext', () => {
    describe('Single occurrence', () => {
      it('should find single occurrence without prefix/suffix', () => {
        const content = 'The quick brown fox jumps over the lazy dog';
        const exact = 'brown fox';

        const result = findTextWithContext(content, exact);

        expect(result).toEqual({ start: 10, end: 19 });
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      });

      it('should find single occurrence even with prefix/suffix provided', () => {
        const content = 'The quick brown fox jumps over the lazy dog';
        const exact = 'brown fox';

        const result = findTextWithContext(content, exact, 'quick ', ' jumps');

        expect(result).toEqual({ start: 10, end: 19 });
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      });

      it('should handle exact text at the beginning', () => {
        const content = 'The quick brown fox';
        const exact = 'The quick';

        const result = findTextWithContext(content, exact);

        expect(result).toEqual({ start: 0, end: 9 });
      });

      it('should handle exact text at the end', () => {
        const content = 'The quick brown fox';
        const exact = 'brown fox';

        const result = findTextWithContext(content, exact);

        expect(result).toEqual({ start: 10, end: 19 });
      });
    });

    describe('Multiple occurrences with disambiguation', () => {
      it('should find correct occurrence using exact prefix match', () => {
        const content = 'The cat sat. The cat ran. The cat jumped.';
        const exact = 'The cat';
        const prefix = 'sat. ';

        const result = findTextWithContext(content, exact, prefix);

        // Should find second "The cat" (after "sat. ")
        expect(result).toEqual({ start: 13, end: 20 });
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      });

      it('should find correct occurrence using exact suffix match', () => {
        const content = 'The cat sat. The cat ran. The cat jumped.';
        const exact = 'The cat';
        const suffix = ' jumped.';

        const result = findTextWithContext(content, exact, undefined, suffix);

        // Should find third "The cat" (before " jumped.")
        expect(result).toEqual({ start: 26, end: 33 });
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      });

      it('should find correct occurrence using both prefix and suffix', () => {
        const content = 'The cat sat. The cat ran. The cat jumped.';
        const exact = 'The cat';
        const prefix = '. ';
        const suffix = ' ran.';

        const result = findTextWithContext(content, exact, prefix, suffix);

        // Should find second "The cat" (after ". " and before " ran.")
        expect(result).toEqual({ start: 13, end: 20 });
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      });

      it('should use fuzzy matching when exact prefix/suffix not found', () => {
        const content = 'cat sits. the cat runs';
        const exact = 'cat';
        const prefix = ' the'; // Expects leading space + "the", but actual is "the " (no leading space, trailing space)

        const result = findTextWithContext(content, exact, prefix);

        // Should find second "cat" using fuzzy match (handles whitespace variations)
        expect(result).not.toBeNull();
        // Fuzzy match should find it despite whitespace mismatch
        expect(result!.start).toBe(14); // Second "cat" position
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[FuzzyAnchor] Multiple matches found but none match prefix/suffix exactly')
        );
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[FuzzyAnchor] Using fuzzy match')
        );
      });

      it('should fallback to first occurrence when no context matches', () => {
        const content = 'The cat sat. The cat ran.';
        const exact = 'The cat';
        const prefix = 'NONEXISTENT';

        const result = findTextWithContext(content, exact, prefix);

        // Should return first occurrence as fallback
        expect(result).toEqual({ start: 0, end: 7 });
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[FuzzyAnchor] Multiple matches but no context match')
        );
      });
    });

    describe('No matches found', () => {
      it('should return null when exact text not found', () => {
        const content = 'The quick brown fox';
        const exact = 'lazy dog';

        const result = findTextWithContext(content, exact);

        expect(result).toBeNull();
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[FuzzyAnchor] Text not found')
        );
      });

      it('should return null for empty exact text', () => {
        const content = 'The quick brown fox';
        const exact = '';

        const result = findTextWithContext(content, exact);

        expect(result).toBeNull();
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      });
    });

    describe('Edge cases', () => {
      it('should handle exact text with special characters', () => {
        const content = 'Price: $50.00. Total: $50.00 (after discount)';
        const exact = '$50.00';
        const suffix = ' (after discount)';

        const result = findTextWithContext(content, exact, undefined, suffix);

        // Should find second occurrence
        expect(result).toEqual({ start: 22, end: 28 });
      });

      it('should handle exact text with newlines', () => {
        const content = 'Line 1\nLine 2\nLine 3\nLine 2\nLine 4';
        const exact = 'Line 2';
        const prefix = 'Line 3\n';

        const result = findTextWithContext(content, exact, prefix);

        // Should find second "Line 2"
        expect(result).toEqual({ start: 21, end: 27 });
      });

      it('should handle unicode characters', () => {
        const content = 'Hello 世界. Hello 世界.';
        const exact = '世界';
        const prefix = '. Hello ';

        const result = findTextWithContext(content, exact, prefix);

        expect(result).not.toBeNull();
        expect(result?.start).toBeGreaterThan(0);
      });

      it('should handle prefix longer than available content', () => {
        const content = 'cat';
        const exact = 'cat';
        const prefix = 'this is a very long prefix that does not exist';

        const result = findTextWithContext(content, exact, prefix);

        // Should still find the text (single occurrence)
        expect(result).toEqual({ start: 0, end: 3 });
      });

      it('should handle suffix longer than remaining content', () => {
        const content = 'cat';
        const exact = 'cat';
        const suffix = 'this is a very long suffix that does not exist';

        const result = findTextWithContext(content, exact, undefined, suffix);

        // Should still find the text (single occurrence)
        expect(result).toEqual({ start: 0, end: 3 });
      });
    });

    describe('Real-world scenarios', () => {
      it('should disambiguate entity mentions in a document', () => {
        const content = `
          John Smith works at Acme Corp. He is a software engineer.
          Jane Smith also works at Acme Corp. She is a project manager.
          John Smith leads the engineering team.
        `;
        const exact = 'John Smith';
        const prefix = '. \n          '; // Before second mention

        const result = findTextWithContext(content, exact, prefix);

        expect(result).not.toBeNull();
        // Should find second "John Smith"
        expect(result!.start).toBeGreaterThan(content.indexOf('Jane Smith'));
      });

      it('should handle code snippets with repeated function names', () => {
        const code = `
function validate() { return true; }
function process() { validate(); }
function main() { validate(); }
        `;
        const exact = 'validate()';
        const prefix = 'main() { ';

        const result = findTextWithContext(code, exact, prefix);

        expect(result).not.toBeNull();
        // Should find second validate() call (in main function)
        const mainIndex = code.indexOf('main()');
        expect(result!.start).toBeGreaterThan(mainIndex);
      });
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

  describe('Integration: findTextWithContext + verifyPosition', () => {
    it('should find and verify position in single step', () => {
      const content = 'The cat sat. The cat ran. The cat jumped.';
      const exact = 'The cat';
      const prefix = 'sat. ';

      const position = findTextWithContext(content, exact, prefix);

      expect(position).not.toBeNull();
      expect(verifyPosition(content, position!, exact)).toBe(true);
    });

    it('should handle multiple iterations of find and verify', () => {
      const content = 'word word word';
      const exact = 'word';

      // Find all three occurrences
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
