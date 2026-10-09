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

import { describe, it, expect, vi } from 'vitest';
import { MotivationParsers } from '../../../workers/detection/motivation-parsers';
import type { Logger } from '@semiont/core';

const LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => LOGGER,
};

// No `@semiont/core` mock — the real `reconcile` runs against the
// synthetic test content. Tests that exercise hallucinated text (offsets
// pointing at words that don't exist in `testContent`) rely on the real
// reconciler dropping them.

describe('MotivationParsers', () => {
  const testContent = 'Alice went to Paris. Bob stayed home.';

  describe('parseComments', () => {
    it('should parse valid comment elements', () => {
      const { matches: result, dropped } = MotivationParsers.parseComments(
        [{ exact: 'Alice', start: 0, end: 5, comment: 'This is a test comment' }],
        testContent, LOGGER,
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
      // for fuzzy match — so `reconcile` returns null.
      const { matches: result, dropped } = MotivationParsers.parseComments(
        [
          { exact: 'Alice', comment: 'Valid comment' },
          { exact: 'XYZNOTPRESENTANYWHEREZYX', comment: 'This will be filtered' },
        ],
        testContent, LOGGER,
      );

      expect(result).toHaveLength(1);
      // The one that was proposed and could not be anchored is counted, not lost.
      expect(dropped).toBe(1);
      expect(result[0]!.exact).toBe('Alice');
    });

    it('should filter out comments with empty comment text', () => {
      const { matches: result, dropped } = MotivationParsers.parseComments(
        [{ exact: 'Alice', start: 0, end: 5, comment: '' }],
        testContent, LOGGER,
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
        testContent, LOGGER,
      );

      expect(result).toHaveLength(1);
      expect(dropped).toBe(0);
      expect(result[0]!.comment).toBe('the only valid element');
    });

    it('passes an empty element list through as a success with no matches', () => {
      expect(MotivationParsers.parseComments([], testContent, LOGGER)).toEqual({ matches: [], dropped: 0 });
    });
  });

  describe('parseHighlights', () => {
    it('should parse valid highlight elements', () => {
      const { matches: result, dropped } = MotivationParsers.parseHighlights(
        [{ exact: 'Bob', start: 21, end: 24 }],
        testContent, LOGGER,
      );

      expect(result).toHaveLength(1);
      expect(dropped).toBe(0);
      expect(result[0]).toMatchObject({ exact: 'Bob', start: 21, end: 24 });
    });

    it('should filter out invalid highlights', () => {
      const { matches: result, dropped } = MotivationParsers.parseHighlights(
        [{ exact: 'Alice' }, { exact: 'XYZNOTPRESENTANYWHEREZYX' }],
        testContent, LOGGER,
      );

      expect(result).toHaveLength(1);
      // The one that was proposed and could not be anchored is counted, not lost.
      expect(dropped).toBe(1);
      expect(result[0]!.exact).toBe('Alice');
    });

    it('passes an empty element list through as a success with no matches', () => {
      expect(MotivationParsers.parseHighlights([], testContent, LOGGER)).toEqual({ matches: [], dropped: 0 });
    });
  });

  describe('parseAssessments', () => {
    it('should parse valid assessment elements', () => {
      const { matches: result, dropped } = MotivationParsers.parseAssessments(
        [{ exact: 'Alice', start: 0, end: 5, assessment: 'This is an assessment' }],
        testContent, LOGGER,
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
        testContent, LOGGER,
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
        [{ exact: 'Alice went to Paris', start: 0, end: 19 }], LOGGER,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ exact: 'Alice went to Paris', start: 0, end: 19 });
    });

    it('reads a tag with an empty exact as a proposal, as every motivation does: anchoring counts it', () => {
      const proposed = MotivationParsers.parseTags([{ exact: '' }], LOGGER);

      expect(proposed).toEqual([{ exact: '' }]);
      // It is anchored nowhere, and counted there.
      expect(MotivationParsers.validateTagOffsets(proposed, testContent, 'Issue', LOGGER)).toEqual({ matches: [], dropped: 1 });
    });

    it('passes an empty element list through as a success with no matches', () => {
      expect(MotivationParsers.parseTags([], LOGGER)).toEqual([]);
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

      const { matches: result, dropped } = MotivationParsers.validateTagOffsets(tags, testContent, 'Issue', LOGGER);

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

      const { matches: result, dropped } = MotivationParsers.validateTagOffsets(tags, testContent, 'Rule', LOGGER);

      expect(result).toHaveLength(1);
      // The one that was proposed and could not be anchored is counted, not lost.
      expect(dropped).toBe(1);
      expect(result[0]!.exact).toBe('Alice');
      expect(result[0]!.category).toBe('Rule');
    });

    it('should handle empty tag array', () => {
      const { matches: result, dropped } = MotivationParsers.validateTagOffsets([], testContent, 'Application', LOGGER);

      expect(result).toEqual([]);
      expect(dropped).toBe(0);
    });
  });

  describe('what a parser says of a reply', () => {
    it('goes to its logger, every word of it: nothing is written to the console', () => {
      const said = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
      const written = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
      const nowhere = 'XYZNOTPRESENTANYWHEREZYX';

      // One proposal in the text and one nowhere in it, for each kind; and for the kinds that say how many elements were proposals, that.
      MotivationParsers.parseHighlights([{ exact: 'Alice' }, { exact: nowhere }], testContent, said);
      MotivationParsers.parseComments([{ exact: 'Alice', comment: 'c' }, { exact: nowhere, comment: 'c' }], testContent, said);
      MotivationParsers.parseAssessments([{ exact: 'Alice', assessment: 'a' }, { exact: nowhere, assessment: 'a' }], testContent, said);
      MotivationParsers.validateTagOffsets(MotivationParsers.parseTags([{ exact: 'Alice' }, { exact: nowhere }], said), testContent, 'Rule', said);

      for (const spy of written) {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
      // Each proposal that could not be anchored is a warning, with the motivation and the text.
      expect(said.warn.mock.calls.map(([message, meta]) => [message, (meta as { motivation: string; text: string }).motivation, (meta as { text: string }).text])).toEqual([
        ['Proposal dropped — text not found in source', 'highlighting', nowhere],
        ['Proposal dropped — text not found in source', 'commenting', nowhere],
        ['Proposal dropped — text not found in source', 'assessing', nowhere],
        ['Proposal dropped — text not found in source', 'tagging', nowhere],
      ]);
      // How many elements of a reply were proposals is said for the two kinds that pass elements over for more than their shape.
      expect(said.debug.mock.calls.map(([, meta]) => meta)).toEqual([
        { motivation: 'commenting', proposals: 2, elements: 2 },
        { motivation: 'tagging', proposals: 2, elements: 2 },
      ]);
    });
  });
});
