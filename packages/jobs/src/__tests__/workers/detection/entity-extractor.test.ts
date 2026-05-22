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

const LOGGER = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: function (this: any) { return this; },
} as unknown as import('@semiont/core').Logger;

describe('extractEntities', () => {

  it('should extract entities with exact text + prefix/suffix context', async () => {
    const text = 'Alice went to Paris yesterday.';
    const mockResponse = [
      { exact: 'Alice', entityType: 'Person', prefix: '', suffix: ' went to' },
      { exact: 'Paris', entityType: 'Location', prefix: 'went to ', suffix: ' yesterday' },
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person', 'Location'], mockInferenceClient, false, LOGGER);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      exact: 'Alice',
      entityType: 'Person',
      prefix: '',
      suffix: ' went to',
    });
    expect(result[1]).toEqual({
      exact: 'Paris',
      entityType: 'Location',
      prefix: 'went to ',
      suffix: ' yesterday',
    });
  });

  it('should handle empty text', async () => {
    mockInferenceClient.setResponses(['[]']);

    const result = await extractEntities('', ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toEqual([]);
  });

  it('should handle no entities found', async () => {
    mockInferenceClient.setResponses(['[]']);

    const result = await extractEntities('The sky is blue', ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toEqual([]);
  });

  it('preserves prefix/suffix context for downstream reconciliation', async () => {
    // The extractor is offset-free; prefix/suffix carry locality context
    // for the downstream reconcileSelector to disambiguate.
    const mockResponse = [
      {
        exact: 'Alice',
        entityType: 'Person',
        prefix: 'Paris. ',
        suffix: ' loves',
      },
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities('Alice went to Paris. Alice loves Paris.', ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      exact: 'Alice',
      entityType: 'Person',
      prefix: 'Paris. ',
      suffix: ' loves',
    });
  });

  it('passes LLM output through verbatim — downstream reconcileSelector decides which entities survive', async () => {
    // `extractEntities` no longer filters and no longer carries offsets.
    // It returns everything the LLM emitted with the required field
    // types; the processor calls `reconcileSelector` per entity and
    // drops the ones whose `exact` isn't in the source.
    const text = 'Alice went to Paris.';
    const mockResponse = [
      { exact: 'Alice', entityType: 'Person' },
      { exact: 'Bob', entityType: 'Person' }, // Not in text — processor will drop
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toHaveLength(2);
    expect(result[0].exact).toBe('Alice');
    expect(result[1].exact).toBe('Bob');
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

    const result = await extractEntities(text, ['Person'], mockInferenceClient, false, LOGGER);

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
      const result = await extractEntities(text, ['Person'], mockInferenceClient, false, LOGGER);
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
      mockInferenceClient,
      false,
      LOGGER,
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

    const result = await extractEntities(text, ['Person'], mockInferenceClient, true, LOGGER);

    expect(result).toHaveLength(2);
    expect(result[0].exact).toBe('Marie Curie');
    expect(result[1].exact).toBe('The Nobel laureate');
  });

  it('should handle malformed JSON gracefully', async () => {
    mockInferenceClient.setResponses(['This is not JSON']);

    const result = await extractEntities('Alice went to Paris.', ['Person'], mockInferenceClient, false, LOGGER);

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
        false, LOGGER, 'fr',
      );
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).toContain('Source text language: French');
    });

    it('omits source-language guidance when not provided', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities('Alice went to Paris.', ['Person'], mockInferenceClient, false, LOGGER);
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).not.toContain('Source text language:');
    });

    it('falls back to the raw tag when the BCP-47 code is unknown', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities(
        'Some text', ['Person'], mockInferenceClient,
        false, LOGGER, 'xx',
      );
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).toContain('Source text language: xx');
    });
  });
});
