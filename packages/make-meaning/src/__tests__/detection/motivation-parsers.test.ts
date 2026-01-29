/**
 * Motivation Parsers Tests
 *
 * Tests the MotivationParsers class which parses and validates AI responses
 * for different annotation motivations.
 */

import { describe, it, expect, vi } from 'vitest';
import { MotivationParsers } from '../../detection/motivation-parsers';

// Mock validateAndCorrectOffsets
vi.mock('@semiont/api-client', () => ({
  validateAndCorrectOffsets: vi.fn((content: string, start: number, end: number, exact: string) => {
    // Simple validation: check if the text at offsets matches exact
    const extracted = content.substring(start, end);
    if (extracted === exact) {
      return {
        start,
        end,
        exact,
        prefix: content.substring(Math.max(0, start - 10), start),
        suffix: content.substring(end, Math.min(content.length, end + 10))
      };
    }
    // If mismatch, throw to simulate validation failure
    throw new Error(`Text mismatch: expected "${exact}", got "${extracted}"`);
  })
}));

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

    it('should filter out invalid comments', () => {
      const response = JSON.stringify([
        {
          exact: 'Alice',
          start: 0,
          end: 5,
          comment: 'Valid comment'
        },
        {
          exact: 'Invalid',
          start: 999, // Invalid offset
          end: 1005,
          comment: 'This will be filtered'
        }
      ]);

      const result = MotivationParsers.parseComments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Alice');
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
        {
          exact: 'Alice',
          start: 0,
          end: 5
        },
        {
          exact: 'Nonexistent',
          start: 999,
          end: 1010
        }
      ]);

      const result = MotivationParsers.parseHighlights(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Alice');
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

    it('should filter out invalid assessments', () => {
      const response = JSON.stringify([
        {
          exact: 'Bob',
          start: 21,
          end: 24,
          assessment: 'Valid'
        },
        {
          exact: 'Invalid',
          start: 999,
          end: 1005,
          assessment: 'Will be filtered'
        }
      ]);

      const result = MotivationParsers.parseAssessments(response, testContent);

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Bob');
    });

    it('should handle malformed JSON gracefully', () => {
      const result = MotivationParsers.parseAssessments('not json', testContent);

      expect(result).toEqual([]);
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
      expect(result[0]).toHaveProperty('prefix');
      expect(result[0]).toHaveProperty('suffix');
    });

    it('should filter out tags with invalid offsets', () => {
      const tags = [
        {
          exact: 'Alice',
          start: 0,
          end: 5
        },
        {
          exact: 'Invalid',
          start: 999,
          end: 1005
        }
      ];

      const result = MotivationParsers.validateTagOffsets(tags, testContent, 'Rule');

      expect(result).toHaveLength(1);
      expect(result[0].exact).toBe('Alice');
      expect(result[0].category).toBe('Rule');
    });

    it('should handle empty tag array', () => {
      const result = MotivationParsers.validateTagOffsets([], testContent, 'Application');

      expect(result).toEqual([]);
    });
  });
});
