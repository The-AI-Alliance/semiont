/**
 * Motivation Parsers Tests
 *
 * Tests the MotivationParsers class which parses and validates AI responses
 * for different annotation motivations.
 *
 * Phase 2b (de-silence): the parsers no longer tolerate malformed output or
 * swallow parse failures into an empty array. Post-Phase-1 both providers emit
 * syntactically-valid, fence-free JSON arrays, so a parse failure is a real
 * failure and must throw (→ job:failed) rather than silently return zero
 * annotations. A legitimately-empty `[]` still parses to a success with no
 * matches. The former tolerant `extractObjectsFromArray` walker is gone.
 */

import { describe, it, expect } from 'vitest';
import { MotivationParsers } from '../../../workers/detection/motivation-parsers';

// No `@semiont/core` mock — the real `reconcileSelector` runs against the
// synthetic test content. Tests that exercise hallucinated text (offsets
// pointing at words that don't exist in `testContent`) rely on the real
// reconciler dropping them.

describe('MotivationParsers', () => {
  const testContent = 'Alice went to Paris. Bob stayed home.';

  describe('parseComments', () => {
    it('should parse valid comment array', () => {
      const response = JSON.stringify([
        {
          exact: 'Alice',
          start: 0,
          end: 5,
          comment: 'This is a test comment'
        }
      ]);

      const result = MotivationParsers.parseComments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        exact: 'Alice',
        start: 0,
        end: 5,
        comment: 'This is a test comment'
      });
    });

    it('drops comments whose exact does not appear in the source', () => {
      // testContent = 'Alice went to Paris. Bob stayed home.'
      // The second item's exact has no plausible anchor — too dissimilar
      // for fuzzy match — so reconcileSelector returns null.
      const response = JSON.stringify([
        {
          exact: 'Alice',
          comment: 'Valid comment'
        },
        {
          exact: 'XYZNOTPRESENTANYWHEREZYX',
          comment: 'This will be filtered'
        }
      ]);

      const result = MotivationParsers.parseComments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0]!.exact).toBe('Alice');
    });

    it('should filter out comments with empty comment text', () => {
      const response = JSON.stringify([
        {
          exact: 'Alice',
          start: 0,
          end: 5,
          comment: ''
        }
      ]);

      const result = MotivationParsers.parseComments(response, testContent);

      expect(result).toHaveLength(0);
    });

    it('parses a legitimately-empty array as a success with no matches', () => {
      expect(MotivationParsers.parseComments('[]', testContent)).toEqual([]);
    });

    it('throws on unparseable response instead of silently returning []', () => {
      expect(() => MotivationParsers.parseComments('not valid json', testContent)).toThrow();
    });

    it('throws on a non-array response instead of silently returning []', () => {
      const response = JSON.stringify({ exact: 'Alice', start: 0, end: 5 });
      expect(() => MotivationParsers.parseComments(response, testContent)).toThrow(/array/i);
    });
  });

  describe('parseHighlights', () => {
    it('should parse valid highlight array', () => {
      const response = JSON.stringify([
        {
          exact: 'Bob',
          start: 21,
          end: 24
        }
      ]);

      const result = MotivationParsers.parseHighlights(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        exact: 'Bob',
        start: 21,
        end: 24
      });
    });

    it('should filter out invalid highlights', () => {
      const response = JSON.stringify([
        { exact: 'Alice' },
        { exact: 'XYZNOTPRESENTANYWHEREZYX' },
      ]);

      const result = MotivationParsers.parseHighlights(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0]!.exact).toBe('Alice');
    });

    it('parses a legitimately-empty array as a success with no matches', () => {
      expect(MotivationParsers.parseHighlights('[]', testContent)).toEqual([]);
    });

    it('throws on unparseable response instead of silently returning []', () => {
      expect(() => MotivationParsers.parseHighlights('{invalid', testContent)).toThrow();
    });
  });

  describe('parseAssessments', () => {
    it('should parse valid assessment array', () => {
      const response = JSON.stringify([
        {
          exact: 'Alice',
          start: 0,
          end: 5,
          assessment: 'This is an assessment'
        }
      ]);

      const result = MotivationParsers.parseAssessments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        exact: 'Alice',
        start: 0,
        end: 5,
        assessment: 'This is an assessment'
      });
    });

    it('drops assessments whose exact does not appear in the source', () => {
      const response = JSON.stringify([
        { exact: 'Bob', assessment: 'Valid' },
        { exact: 'XYZNOTPRESENTANYWHEREZYX', assessment: 'Will be filtered' },
      ]);

      const result = MotivationParsers.parseAssessments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0]!.exact).toBe('Bob');
    });

    it('throws on unparseable response instead of silently returning []', () => {
      expect(() => MotivationParsers.parseAssessments('not json', testContent)).toThrow();
    });

    it('throws on stray tokens between array elements instead of partially recovering', () => {
      // Pre-Phase-2 the tolerant walker recovered the two well-formed objects
      // around a hallucinated `wide: 0,` line. Post-Phase-1 such output cannot
      // come from a constrained provider, so it is a real parse failure that
      // must fail the job loudly rather than silently surface partial results.
      const response = `[
  { "exact": "Alice", "start": 0, "end": 5, "assessment": "First assessment" },
  wide: 0,
  { "exact": "Bob", "start": 21, "end": 24, "assessment": "Second assessment" }
]`;

      expect(() => MotivationParsers.parseAssessments(response, testContent)).toThrow();
    });
  });

  describe('parseTags', () => {
    it('should parse valid tag array without validation', () => {
      const response = JSON.stringify([
        {
          exact: 'Alice went to Paris',
          start: 0,
          end: 19
        }
      ]);

      const result = MotivationParsers.parseTags(response);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        exact: 'Alice went to Paris',
        start: 0,
        end: 19
      });
    });

    it('should filter out tags with empty exact text', () => {
      const response = JSON.stringify([
        {
          exact: '',
          start: 0,
          end: 0
        }
      ]);

      const result = MotivationParsers.parseTags(response);

      expect(result).toHaveLength(0);
    });

    it('parses a legitimately-empty array as a success with no matches', () => {
      expect(MotivationParsers.parseTags('[]')).toEqual([]);
    });

    it('throws on unparseable response instead of silently returning []', () => {
      expect(() => MotivationParsers.parseTags('invalid json')).toThrow();
    });

    it('throws on a non-array response instead of silently returning []', () => {
      const response = JSON.stringify({ exact: 'test', start: 0, end: 4 });
      expect(() => MotivationParsers.parseTags(response)).toThrow(/array/i);
    });
  });

  describe('validateTagOffsets', () => {
    it('should validate tag offsets and add category', () => {
      const tags = [
        {
          exact: 'Alice',
          start: 0,
          end: 5
        }
      ];

      const result = MotivationParsers.validateTagOffsets(tags, testContent, 'Issue');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        exact: 'Alice',
        start: 0,
        end: 5,
        category: 'Issue'
      });
      // 'Alice' is at the start of content — no prefix is correct.
      // Suffix is present and aligns with what follows.
      expect(result[0]!.prefix).toBeUndefined();
      expect(result[0]!.suffix).toBeDefined();
      expect(testContent.substring(result[0]!.end, result[0]!.end + result[0]!.suffix!.length)).toBe(result[0]!.suffix);
    });

    it('should filter out tags with invalid offsets', () => {
      const tags = [
        { exact: 'Alice' },
        { exact: 'XYZNOTPRESENTANYWHEREZYX' },
      ];

      const result = MotivationParsers.validateTagOffsets(tags, testContent, 'Rule');

      expect(result).toHaveLength(1);
      expect(result[0]!.exact).toBe('Alice');
      expect(result[0]!.category).toBe('Rule');
    });

    it('should handle empty tag array', () => {
      const result = MotivationParsers.validateTagOffsets([], testContent, 'Application');

      expect(result).toEqual([]);
    });
  });
});
