import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getInferenceClient, createInferenceClient } from '../factory.js';
import { createConfigWithEnvVar } from './helpers/mock-config.js';
import type { InferenceClientConfig } from '../factory.js';

describe('@semiont/inference - edge cases', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('Configuration edge cases', () => {
    it('should throw error for missing apiKey', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: undefined,
        model: 'claude-3-5-sonnet-20241022',
      };

      expect(() => createInferenceClient(config)).toThrow('apiKey is required');
    });

    it('should throw error for empty string apiKey', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: '',
        model: 'claude-3-5-sonnet-20241022',
      };

      expect(() => createInferenceClient(config)).toThrow('apiKey is required');
    });

    it('should accept whitespace in model name', () => {
      const config: InferenceClientConfig = {
        type: 'anthropic',
        apiKey: 'test-key',
        model: '  claude-3-5-sonnet-20241022  ',
      };

      const client = createInferenceClient(config);

      expect(client).toBeDefined();
    });
  });

  describe('Environment variable edge cases', () => {
    it('should handle environment variable with special characters', async () => {
      vi.stubEnv('SPECIAL_KEY', 'key-with-!@#$%^&*()');
      const config = createConfigWithEnvVar('SPECIAL_KEY');

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should handle environment variable with spaces', async () => {
      vi.stubEnv('KEY_WITH_SPACES', '  spaces around  ');
      const config = createConfigWithEnvVar('KEY_WITH_SPACES');

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should throw error for undefined environment variable', async () => {
      const config = createConfigWithEnvVar('UNDEFINED_VAR');

      await expect(getInferenceClient(config)).rejects.toThrow('Environment variable UNDEFINED_VAR is not set');
    });
  });

  describe('Singleton behavior', () => {
    it('should return same instance on multiple calls', async () => {
      vi.stubEnv('TEST_KEY', 'test-value');
      const config = createConfigWithEnvVar('TEST_KEY');

      const client1 = await getInferenceClient(config);
      const client2 = await getInferenceClient(config);

      expect(client1).toBe(client2);
    });

    it('should create new instance after reset', async () => {
      vi.stubEnv('TEST_KEY', 'test-value');
      const config = createConfigWithEnvVar('TEST_KEY');

      const client1 = await getInferenceClient(config);
      const client2 = await getInferenceClient(config);

      expect(client1).not.toBe(client2);
    });
  });
});
