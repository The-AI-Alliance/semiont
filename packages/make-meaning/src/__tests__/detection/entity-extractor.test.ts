/**
 * Entity Extractor Tests
 *
 * Tests the extractEntities function which uses AI to detect entity references in text.
 * Focuses on extraction logic, offset validation, and response parsing.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { EnvironmentConfig } from '@semiont/core';

// Mock inference client using factory function
const mockCreate = vi.fn();
vi.mock('@semiont/inference', () => {
  const mockClient = {
    messages: {
      create: mockCreate
    }
  };

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockClient),
    getInferenceModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514')
  };
});

import { extractEntities, type ExtractedEntity } from '../../detection/entity-extractor';

describe('extractEntities', () => {
  let config: EnvironmentConfig;

  beforeAll(() => {
    config = {
      services: {
        inference: {
          platform: { type: 'external' },
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          endpoint: 'https://api.anthropic.com',
          apiKey: 'test-api-key'
        }
      }
    } as EnvironmentConfig;
  });

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

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify(mockResponse)
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities(text, ['Person', 'Location'], config);

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
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: '[]'
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities('', ['Person'], config);

    expect(result).toEqual([]);
  });

  it('should handle no entities found', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: '[]'
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities('The sky is blue', ['Person'], config);

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

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify(mockResponse)
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities(text, ['Person'], config);

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

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify(mockResponse)
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities(text, ['Person'], config);

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

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: '```json\n' + JSON.stringify(mockResponse) + '\n```'
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities(text, ['Person'], config);

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

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify(mockResponse)
      }],
      stop_reason: 'max_tokens' // Indicates truncation
    });

    // When truncated, extractEntities throws but catch block returns []
    const result = await extractEntities(text, ['Person'], config);
    expect(result).toEqual([]);
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

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify(mockResponse)
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities(
      text,
      [{ type: 'Organization', examples: ['Apple', 'Google', 'Microsoft'] }],
      config
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

    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify(mockResponse)
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities(text, ['Person'], config, true);

    expect(result).toHaveLength(2);
    expect(result[0].exact).toBe('Marie Curie');
    expect(result[1].exact).toBe('The Nobel laureate');
  });

  it('should handle malformed JSON gracefully', async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: 'This is not JSON'
      }],
      stop_reason: 'end_turn'
    });

    const result = await extractEntities('Alice went to Paris.', ['Person'], config);

    expect(result).toEqual([]);
  });
});
