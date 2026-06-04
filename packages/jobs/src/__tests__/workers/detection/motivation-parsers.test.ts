/**
 * Motivation Parsers Tests
 *
 * Tests the MotivationParsers class which parses and validates AI responses
 * for different annotation motivations.
 */

import { describe, it, expect } from 'vitest';
import { MotivationParsers, extractObjectsFromArray } from '../../../workers/detection/motivation-parsers';

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

    it('should handle markdown-wrapped JSON', () => {
      const response = '```json\n' + JSON.stringify([
        {
          exact: 'Paris',
          start: 14,
          end: 19,
          comment: 'A city'
        }
      ]) + '\n```';

      const result = MotivationParsers.parseComments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Paris');
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

    it('should handle malformed JSON gracefully', () => {
      const result = MotivationParsers.parseComments('not valid json', testContent);

      expect(result).toEqual([]);
    });

    it('should handle non-array response', () => {
      const response = JSON.stringify({ exact: 'Alice', start: 0, end: 5 });

      const result = MotivationParsers.parseComments(response, testContent);

      expect(result).toEqual([]);
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

    it('should handle markdown code fence variants', () => {
      const response = '```\n' + JSON.stringify([
        {
          exact: 'Paris',
          start: 14,
          end: 19
        }
      ]) + '\n```';

      const result = MotivationParsers.parseHighlights(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Paris');
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

    it('should handle malformed JSON gracefully', () => {
      const result = MotivationParsers.parseHighlights('{invalid', testContent);

      expect(result).toEqual([]);
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

    it('should handle markdown-wrapped JSON', () => {
      const response = '```json\n' + JSON.stringify([
        {
          exact: 'Paris',
          start: 14,
          end: 19,
          assessment: 'Capital of France'
        }
      ]) + '\n```';

      const result = MotivationParsers.parseAssessments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Paris');
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

    it('should handle malformed JSON gracefully', () => {
      const result = MotivationParsers.parseAssessments('not json', testContent);

      expect(result).toEqual([]);
    });

    it('should recover valid objects when LLM emits stray tokens between array elements', () => {
      // Regression: gemma4:26b hallucinated a bare `wide: 0,` line between
      // two well-formed objects, breaking strict JSON.parse. The tolerant
      // parser must still surface the recoverable objects so the user sees
      // partial results rather than a silent zero-count "success".
      const response = `\`\`\`json
[
  {
    "exact": "Alice",
    "start": 0,
    "end": 5,
    "assessment": "First assessment"
  },
  wide: 0,
  {
    "exact": "Bob",
    "start": 21,
    "end": 24,
    "assessment": "Second assessment"
  }
]
\`\`\``;

      const result = MotivationParsers.parseAssessments(response, testContent);

      expect(result).toHaveLength(2);
      expect(result[0].exact).toBe('Alice');
      expect(result[1].exact).toBe('Bob');
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

    it('should handle markdown-wrapped JSON', () => {
      const response = '```json\n' + JSON.stringify([
        {
          exact: 'Bob stayed home',
          start: 21,
          end: 36
        }
      ]) + '\n```';

      const result = MotivationParsers.parseTags(response);

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Bob stayed home');
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

    it('should handle malformed JSON gracefully', () => {
      const result = MotivationParsers.parseTags('invalid json');

      expect(result).toEqual([]);
    });

    it('should handle non-array response', () => {
      const response = JSON.stringify({ exact: 'test', start: 0, end: 4 });

      const result = MotivationParsers.parseTags(response);

      expect(result).toEqual([]);
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

// ─────────────────────────────────────────────────────────────────────
// extractObjectsFromArray — the tolerant array extractor used by every
// parser above. Shipped with minimal coverage (one end-to-end case via
// parseAssessments); these direct tests pin the state-machine contract
// so future edits don't silently break nested-brace / escape handling.
// ─────────────────────────────────────────────────────────────────────

describe('extractObjectsFromArray', () => {
  it('parses a well-formed JSON array (fast path)', () => {
    const result = extractObjectsFromArray('[{"a":1},{"b":2}]');
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('strips ```json markdown fences', () => {
    const result = extractObjectsFromArray('```json\n[{"a":1}]\n```');
    expect(result).toEqual([{ a: 1 }]);
  });

  it('strips plain ``` fences', () => {
    const result = extractObjectsFromArray('```\n[{"a":1}]\n```');
    expect(result).toEqual([{ a: 1 }]);
  });

  it('returns [] for empty input', () => {
    expect(extractObjectsFromArray('')).toEqual([]);
    expect(extractObjectsFromArray('   \n\t  ')).toEqual([]);
  });

  it('returns [] when response has no array brackets at all', () => {
    expect(extractObjectsFromArray('not json')).toEqual([]);
    expect(extractObjectsFromArray('{"a":1}')).toEqual([]); // object, not array
  });

  it('parses an empty JSON array', () => {
    expect(extractObjectsFromArray('[]')).toEqual([]);
  });

  it('recovers well-formed objects when stray tokens sit between them (the wide:0 case)', () => {
    // Regression: gemma4:26b emitted `wide: 0,` between two valid objects.
    const response = '[{"a":1},\n  wide: 0,\n{"b":2}]';
    const result = extractObjectsFromArray(response);
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips malformed objects but keeps surrounding valid ones', () => {
    const response = '[{"a":1}, {broken: "no quotes"}, {"c":3}]';
    const result = extractObjectsFromArray(response);
    expect(result).toEqual([{ a: 1 }, { c: 3 }]);
  });

  it('treats braces inside string values as literal, not as object delimiters', () => {
    // The `}` inside "ugly: }junk" must not close the outer object.
    const response = '[{"note":"ugly: }junk"},{"b":2}]';
    const result = extractObjectsFromArray(response);
    expect(result).toEqual([{ note: 'ugly: }junk' }, { b: 2 }]);
  });

  it('handles escaped quotes inside strings without losing object boundaries', () => {
    const response = '[{"quote":"she said \\"hi\\""},{"b":2}]';
    const result = extractObjectsFromArray(response);
    expect(result).toEqual([{ quote: 'she said "hi"' }, { b: 2 }]);
  });

  it('handles multi-line objects across newlines', () => {
    const response = `[
  {
    "a": 1,
    "b": "two"
  },
  {
    "c": 3
  }
]`;
    const result = extractObjectsFromArray(response);
    expect(result).toEqual([{ a: 1, b: 'two' }, { c: 3 }]);
  });

  it('tolerates prose before and after the array', () => {
    const response = 'Here is the answer:\n[{"a":1}]\n\nThat is all.';
    const result = extractObjectsFromArray(response);
    expect(result).toEqual([{ a: 1 }]);
  });

  it('returns [] when brackets exist but contain nothing recoverable', () => {
    expect(extractObjectsFromArray('[garbage, more garbage]')).toEqual([]);
  });

  it('skips an unclosed object at the end but keeps earlier valid ones', () => {
    // Worker saw a response where the final object was cut off mid-stream.
    // The tolerant parser should still return whatever closed cleanly.
    const response = '[{"a":1},{"b":2},{"c":';
    const result = extractObjectsFromArray(response);
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
