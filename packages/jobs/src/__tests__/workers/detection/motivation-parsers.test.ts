/**
 * Motivation Parsers Tests
 *
 * Tests the MotivationParsers class, which validates and reconciles
 * ALREADY-PARSED elements from the structured inference surface. "Could
 * not read the model" throws inside `generateStructured` and never reaches
 * this layer — the unparseable-string / non-array throws are tested
 * upstream with the behavior (see `anthropic-structured.test.ts` and
 * `ollama.test.ts`). What this layer owns: per-element structural validation
 * (the last line on the Ollama path and the schema/type drift guard) and
 * reconciliation against the full document.
 */

import { describe, it, expect } from 'vitest';
import { MotivationParsers } from '../../../workers/detection/motivation-parsers';
import { textOffsets } from '@semiont/core';

// No `@semiont/core` mock — the real `reconcileSelector` runs against the
// synthetic test content. Tests that exercise hallucinated text (offsets
// pointing at words that don't exist in `testContent`) rely on the real
// reconciler dropping them.

describe('MotivationParsers', () => {
  const testContent = 'Alice went to Paris. Bob stayed home.';

  describe('parseComments', () => {
    it('should parse valid comment elements', () => {
      const { matches: result, dropped } = MotivationParsers.parseComments(
        [{ exact: 'Alice', start: 0, end: 5, comment: 'This is a test comment' }],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(1);
      expect(dropped).toBe(0);
      expect(result[0]).toMatchObject({
        exact: 'Alice',
        start: 0,
        end: 5,
        comment: 'This is a test comment',
      });
    });

    it('drops comments whose exact does not appear in the source', () => {
      // testContent = 'Alice went to Paris. Bob stayed home.'
      // The second item's exact has no plausible anchor — too dissimilar
      // for fuzzy match — so reconcileSelector returns null.
      const { matches: result, dropped } = MotivationParsers.parseComments(
        [
          { exact: 'Alice', comment: 'Valid comment' },
          { exact: 'XYZNOTPRESENTANYWHEREZYX', comment: 'This will be filtered' },
        ],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(1);
      // The one that was proposed and could not be anchored is counted, not lost.
      expect(dropped).toBe(1);
      expect(result[0]!.exact).toBe('Alice');
    });

    it('should filter out comments with empty comment text', () => {
      const { matches: result, dropped } = MotivationParsers.parseComments(
        [{ exact: 'Alice', start: 0, end: 5, comment: '' }],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(0);
      expect(dropped).toBe(0);
    });

    it('drops structurally-invalid elements — the schema/type drift guard', () => {
      const { matches: result, dropped } = MotivationParsers.parseComments(
        [
          null,
          'not an object',
          { exact: 42, comment: 'exact is not a string' },
          { exact: 'Alice', comment: 'the only valid element' },
        ],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(1);
      expect(dropped).toBe(0);
      expect(result[0]!.comment).toBe('the only valid element');
    });

    it('passes an empty element list through as a success with no matches', () => {
      expect(MotivationParsers.parseComments([], testContent, textOffsets(testContent))).toEqual({ matches: [], dropped: 0 });
    });
  });

  describe('parseHighlights', () => {
    it('should parse valid highlight elements', () => {
      const { matches: result, dropped } = MotivationParsers.parseHighlights(
        [{ exact: 'Bob', start: 21, end: 24 }],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(1);
      expect(dropped).toBe(0);
      expect(result[0]).toMatchObject({ exact: 'Bob', start: 21, end: 24 });
    });

    it('should filter out invalid highlights', () => {
      const { matches: result, dropped } = MotivationParsers.parseHighlights(
        [{ exact: 'Alice' }, { exact: 'XYZNOTPRESENTANYWHEREZYX' }],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(1);
      // The one that was proposed and could not be anchored is counted, not lost.
      expect(dropped).toBe(1);
      expect(result[0]!.exact).toBe('Alice');
    });

    it('passes an empty element list through as a success with no matches', () => {
      expect(MotivationParsers.parseHighlights([], testContent, textOffsets(testContent))).toEqual({ matches: [], dropped: 0 });
    });
  });

  describe('parseAssessments', () => {
    it('should parse valid assessment elements', () => {
      const { matches: result, dropped } = MotivationParsers.parseAssessments(
        [{ exact: 'Alice', start: 0, end: 5, assessment: 'This is an assessment' }],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(1);
      expect(dropped).toBe(0);
      expect(result[0]).toMatchObject({
        exact: 'Alice',
        start: 0,
        end: 5,
        assessment: 'This is an assessment',
      });
    });

    it('drops assessments whose exact does not appear in the source', () => {
      const { matches: result, dropped } = MotivationParsers.parseAssessments(
        [
          { exact: 'Bob', assessment: 'Valid' },
          { exact: 'XYZNOTPRESENTANYWHEREZYX', assessment: 'Will be filtered' },
        ],
        testContent, textOffsets(testContent),
      );

      expect(result).toHaveLength(1);
      // The one that was proposed and could not be anchored is counted, not lost.
      expect(dropped).toBe(1);
      expect(result[0]!.exact).toBe('Bob');
    });
  });

  describe('parseTags', () => {
    it('should parse valid tag elements without validation', () => {
      const result = MotivationParsers.parseTags(
        [{ exact: 'Alice went to Paris', start: 0, end: 19 }],
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ exact: 'Alice went to Paris', start: 0, end: 19 });
    });

    it('should filter out tags with empty exact text', () => {
      const result = MotivationParsers.parseTags([{ exact: '', start: 0, end: 0 }]);

      expect(result).toHaveLength(0);
    });

    it('passes an empty element list through as a success with no matches', () => {
      expect(MotivationParsers.parseTags([])).toEqual([]);
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

      const { matches: result, dropped } = MotivationParsers.validateTagOffsets(tags, testContent, textOffsets(testContent), 'Issue');

      expect(result).toHaveLength(1);
      expect(dropped).toBe(0);
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

      const { matches: result, dropped } = MotivationParsers.validateTagOffsets(tags, testContent, textOffsets(testContent), 'Rule');

      expect(result).toHaveLength(1);
      // The one that was proposed and could not be anchored is counted, not lost.
      expect(dropped).toBe(1);
      expect(result[0]!.exact).toBe('Alice');
      expect(result[0]!.category).toBe('Rule');
    });

    it('should handle empty tag array', () => {
      const { matches: result, dropped } = MotivationParsers.validateTagOffsets([], testContent, textOffsets(testContent), 'Application');

      expect(result).toEqual([]);
      expect(dropped).toBe(0);
    });
  });
});
