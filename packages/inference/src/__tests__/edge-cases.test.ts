import { describe, it, expect } from 'vitest';
import { createInferenceClient } from '../factory.js';
import type { InferenceClientConfig } from '../factory.js';

describe('@semiont/inference - edge cases', () => {
  describe('Configuration edge cases', () => {
    it('should throw error for missing apiKey', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: undefined,
        model: 'claude-haiku-4-5-20251001',
      };

      expect(() => createInferenceClient(config)).toThrow('apiKey is required');
    });

    it('should throw error for empty string apiKey', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: '',
        model: 'claude-haiku-4-5-20251001',
      };

      expect(() => createInferenceClient(config)).toThrow('apiKey is required');
    });

    it('should accept whitespace in model name', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: 'test-key',
        model: '  claude-haiku-4-5-20251001  ',
      };

      const client = createInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should create new instances independently (no singleton)', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-haiku-4-5-20251001',
      };

      const client1 = createInferenceClient(config);
      const client2 = createInferenceClient(config);

      expect(client1).not.toBe(client2);
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
    });
  });
});
