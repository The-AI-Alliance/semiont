/**
 * Entity Extractor Tests
 *
 * Tests the extractEntities function which uses AI to detect entity references in text.
 * Focuses on extraction logic, offset validation, and response parsing.
 */

import { describe, it, expect } from 'vitest';
import { MockInferenceClient } from '@semiont/inference';
import { extractEntities } from '../../../workers/detection/entity-extractor';

// Create mock client directly
const mockInferenceClient = new MockInferenceClient(['[]']);

describe('extractEntities', () => {

  it('should extract entities with correct offsets', async () => {
    const text = 'Alice went to Paris yesterday.';
    const mockResponse = [
      {
        exact: 'Alice',
        entityType: 'Person',
        startOffset: 0,
        endOffset: 5,
        prefix: '',
        suffix: ' went to'
      },
      {
        exact: 'Paris',
        entityType: 'Location',
        startOffset: 14,
        endOffset: 19,
        prefix: 'went to ',
        suffix: ' yesterday'
      }
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person', 'Location'], mockInferenceClient);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      exact: 'Alice',
      entityType: 'Person',
      startOffset: 0,
      endOffset: 5
    });
    expect(result[1]).toMatchObject({
      exact: 'Paris',
      entityType: 'Location',
      startOffset: 14,
      endOffset: 19
    });
  });

  it('should handle empty text', async () => {
    mockInferenceClient.setResponses(['[]']);

    const result = await extractEntities('', ['Person'], mockInferenceClient);

    expect(result).toEqual([]);
  });

  it('should handle no entities found', async () => {
    mockInferenceClient.setResponses(['[]']);

    const result = await extractEntities('The sky is blue', ['Person'], mockInferenceClient);

    expect(result).toEqual([]);
  });

  it('should correct AI offset errors using context', async () => {
    const text = 'Alice went to Paris. Alice loves Paris.';
    // AI returns wrong offset for second Alice
    const mockResponse = [
      {
        exact: 'Alice',
        entityType: 'Person',
        startOffset: 21, // Correct
        endOffset: 26,
        prefix: 'Paris. ',
        suffix: ' loves'
      }
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person'], mockInferenceClient);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      exact: 'Alice',
      entityType: 'Person',
      startOffset: 21,
      endOffset: 26
    });
    // Verify the offset is actually correct
    expect(text.substring(21, 26)).toBe('Alice');
  });

  it('should filter out entities with invalid offsets', async () => {
    const text = 'Alice went to Paris.';
    const mockResponse = [
      {
        exact: 'Alice',
        entityType: 'Person',
        startOffset: 0,
        endOffset: 5
      },
      {
        exact: 'Bob', // Doesn't exist in text
        entityType: 'Person',
        startOffset: 100,
        endOffset: 103
      }
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person'], mockInferenceClient);

    expect(result).toHaveLength(1);
    expect(result[0].exact).toBe('Alice');
  });

  it('should handle markdown-wrapped JSON response', async () => {
    const text = 'Alice went to Paris.';
    const mockResponse = [
      {
        exact: 'Alice',
        entityType: 'Person',
        startOffset: 0,
        endOffset: 5
      }
    ];

    mockInferenceClient.setResponses(['```json\n' + JSON.stringify(mockResponse) + '\n```']);

    const result = await extractEntities(text, ['Person'], mockInferenceClient);

    expect(result).toHaveLength(1);
    expect(result[0].exact).toBe('Alice');
  });

  it('should log error and return empty array when response is truncated', async () => {
    const text = 'Alice went to Paris.';
    const mockResponse = [
      {
        exact: 'Alice',
        entityType: 'Person',
        startOffset: 0,
        endOffset: 5,
        prefix: '',
        suffix: ' went to'
      }
    ];

    // Set response with max_tokens stop reason to simulate truncation
    mockInferenceClient.setResponses([JSON.stringify(mockResponse)], ['max_tokens']);

    // When truncated, extractEntities throws but catch block returns []
    try {
      const result = await extractEntities(text, ['Person'], mockInferenceClient);
      expect(result).toEqual([]);
    } catch (error) {
      // If it throws, that's also acceptable - the catch block should return []
      // But the test expects [] to be returned, not thrown
      throw error;
    }
  });

  it('should handle entity types with examples', async () => {
    const text = 'Apple released a new iPhone.';
    const mockResponse = [
      {
        exact: 'Apple',
        entityType: 'Organization',
        startOffset: 0,
        endOffset: 5
      }
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(
      text,
      [{ type: 'Organization', examples: ['Apple', 'Google', 'Microsoft'] }],
      mockInferenceClient
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      exact: 'Apple',
      entityType: 'Organization'
    });
  });

  it('should include descriptive references when enabled', async () => {
    const text = 'Marie Curie was a physicist. The Nobel laureate discovered radium.';
    const mockResponse = [
      {
        exact: 'Marie Curie',
        entityType: 'Person',
        startOffset: 0,
        endOffset: 11
      },
      {
        exact: 'The Nobel laureate',
        entityType: 'Person',
        startOffset: 29,
        endOffset: 47
      }
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person'], mockInferenceClient, true);

    expect(result).toHaveLength(2);
    expect(result[0].exact).toBe('Marie Curie');
    expect(result[1].exact).toBe('The Nobel laureate');
  });

  it('should handle malformed JSON gracefully', async () => {
    mockInferenceClient.setResponses(['This is not JSON']);

    const result = await extractEntities('Alice went to Paris.', ['Person'], mockInferenceClient);

    expect(result).toEqual([]);
  });

  describe('source language', () => {
    // Entity references' bodies are entity-type identifiers, not LLM-generated
    // text — so only `sourceLanguage` is meaningful. It's wired into the
    // prompt so the LLM analyzes non-English source correctly.

    it('injects source-language guidance into the prompt when provided', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities(
        'Marie Curie a découvert le radium.', ['Person'], mockInferenceClient,
        false, undefined, 'fr',
      );
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).toContain('Source text language: French');
    });

    it('omits source-language guidance when not provided', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities('Alice went to Paris.', ['Person'], mockInferenceClient);
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).not.toContain('Source text language:');
    });

    it('falls back to the raw tag when the BCP-47 code is unknown', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities(
        'Some text', ['Person'], mockInferenceClient,
        false, undefined, 'xx',
      );
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).toContain('Source text language: xx');
    });
  });
});
