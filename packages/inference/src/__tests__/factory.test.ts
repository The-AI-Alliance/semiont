import { describe, it, expect } from 'vitest';
import { createInferenceClient } from '../factory.js';

describe('@semiont/inference - factory', () => {
  describe('createInferenceClient', () => {
    it('should create an inference client with Anthropic provider', () => {
      const client = createInferenceClient({
        provider: 'anthropic',
        apiKey: 'test-key',
      });

      expect(client).toBeDefined();
      expect(client).toHaveProperty('generateText');
      expect(client).toHaveProperty('extractEntities');
    });

    it('should create an inference client with OpenAI provider', () => {
      const client = createInferenceClient({
        provider: 'openai',
        apiKey: 'test-key',
      });

      expect(client).toBeDefined();
      expect(client).toHaveProperty('generateText');
      expect(client).toHaveProperty('extractEntities');
    });

    it('should throw error for missing API key', () => {
      expect(() => {
        createInferenceClient({
          provider: 'anthropic',
          // @ts-expect-error - testing missing apiKey
          apiKey: undefined,
        });
      }).toThrow();
    });
  });
});
