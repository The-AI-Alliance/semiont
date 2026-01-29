import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInferenceClient } from '../factory.js';
import { MockInferenceClient } from '../implementations/mock.js';
import type { InferenceClientConfig } from '../factory.js';

describe('@semiont/inference - integration', () => {
  let mockClient: MockInferenceClient;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockClient = new MockInferenceClient(['Test response']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createInferenceClient', () => {
    it('should create Anthropic client with correct config', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      };

      const client = createInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should throw error if apiKey is missing', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: undefined,
        model: 'claude-3-5-sonnet-20241022',
      };

      expect(() => createInferenceClient(config)).toThrow('apiKey is required');
    });

    it('should accept custom endpoint', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
        endpoint: 'https://custom.endpoint.com',
      };

      const client = createInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should accept custom baseURL', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
        baseURL: 'https://custom.baseurl.com',
      };

      const client = createInferenceClient(config);

      expect(client).toBeDefined();
    });
  });

  describe('InferenceClient.generateText', () => {
    it('should generate text with correct parameters', async () => {
      mockClient.setResponses(['Test response']);

      const result = await mockClient.generateText('Test prompt', 1000, 0.8);

      expect(result).toBe('Test response');
      expect(mockClient.calls).toHaveLength(1);
      expect(mockClient.calls[0]).toEqual({
        prompt: 'Test prompt',
        maxTokens: 1000,
        temperature: 0.8,
      });
    });

    it('should pass prompt to client', async () => {
      mockClient.setResponses(['Response']);

      await mockClient.generateText('My custom prompt', 500, 0.7);

      expect(mockClient.calls[0].prompt).toBe('My custom prompt');
    });

    it('should use provided maxTokens parameter', async () => {
      mockClient.setResponses(['Response']);

      await mockClient.generateText('Test', 2000, 0.7);

      expect(mockClient.calls[0].maxTokens).toBe(2000);
    });

    it('should use provided temperature parameter', async () => {
      mockClient.setResponses(['Response']);

      await mockClient.generateText('Test', 500, 0.5);

      expect(mockClient.calls[0].temperature).toBe(0.5);
    });

    it('should return generated text', async () => {
      mockClient.setResponses(['Expected text content']);

      const result = await mockClient.generateText('Test', 500, 0.7);

      expect(result).toBe('Expected text content');
    });

    it('should handle multiple calls', async () => {
      mockClient.setResponses(['Response 1', 'Response 2']);

      const result1 = await mockClient.generateText('First call', 500, 0.7);
      const result2 = await mockClient.generateText('Second call', 500, 0.7);

      expect(result1).toBe('Response 1');
      expect(result2).toBe('Response 2');
      expect(mockClient.calls).toHaveLength(2);
    });

    it('should handle concurrent calls', async () => {
      mockClient.setResponses(['Response']);

      const results = await Promise.all([
        mockClient.generateText('Prompt 1', 500, 0.7),
        mockClient.generateText('Prompt 2', 500, 0.7),
        mockClient.generateText('Prompt 3', 500, 0.7),
      ]);

      expect(results).toHaveLength(3);
      expect(results.every(r => r === 'Response')).toBe(true);
      expect(mockClient.calls).toHaveLength(3);
    });
  });

  describe('Parameter edge cases', () => {
    it('should handle maxTokens of 0', async () => {
      mockClient.setResponses(['Response']);

      await mockClient.generateText('Test', 0, 0.7);

      expect(mockClient.calls[0].maxTokens).toBe(0);
    });

    it('should handle very large maxTokens', async () => {
      mockClient.setResponses(['Response']);

      await mockClient.generateText('Test', 100000, 0.7);

      expect(mockClient.calls[0].maxTokens).toBe(100000);
    });

    it('should handle temperature of 0', async () => {
      mockClient.setResponses(['Response']);

      await mockClient.generateText('Test', 500, 0);

      expect(mockClient.calls[0].temperature).toBe(0);
    });

    it('should handle temperature of 1', async () => {
      mockClient.setResponses(['Response']);

      await mockClient.generateText('Test', 500, 1);

      expect(mockClient.calls[0].temperature).toBe(1);
    });
  });

  describe('Prompt edge cases', () => {
    it('should handle empty prompts', async () => {
      mockClient.setResponses(['Response']);

      const result = await mockClient.generateText('', 500, 0.7);

      expect(result).toBe('Response');
      expect(mockClient.calls[0].prompt).toBe('');
    });

    it('should handle very large prompts', async () => {
      mockClient.setResponses(['Response']);
      const largePrompt = 'a'.repeat(10000);

      await mockClient.generateText(largePrompt, 500, 0.7);

      expect(mockClient.calls[0].prompt).toHaveLength(10000);
    });

    it('should handle special characters in prompts', async () => {
      mockClient.setResponses(['Response']);
      const specialPrompt = 'Hello\\n\\nWorld\\t"quotes"\\n\'single\'\\n${variable}\\n`backticks`';

      await mockClient.generateText(specialPrompt, 500, 0.7);

      expect(mockClient.calls[0].prompt).toBe(specialPrompt);
    });

    it('should handle unicode in prompts', async () => {
      mockClient.setResponses(['Response']);
      const unicodePrompt = 'Hello 世界 🌍 emoji';

      await mockClient.generateText(unicodePrompt, 500, 0.7);

      expect(mockClient.calls[0].prompt).toBe(unicodePrompt);
    });
  });
});
