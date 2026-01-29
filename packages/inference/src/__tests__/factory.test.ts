import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getInferenceClient, getInferenceModel } from '../factory.js';
import {
  createTestConfig,
  createConfigWithoutInference,
  createConfigWithoutModel,
  createConfigWithEnvVar,
} from './helpers/mock-config.js';

describe('@semiont/inference - factory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('getInferenceModel', () => {
    it('should return the configured model', () => {
      const config = createTestConfig();
      const model = getInferenceModel(config);
      expect(model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should throw error if model is not configured', () => {
      const config = createConfigWithoutModel();
      expect(() => getInferenceModel(config)).toThrow('Inference model not configured');
    });

    it('should throw error if inference config is missing', () => {
      const config = createConfigWithoutInference();
      expect(() => getInferenceModel(config)).toThrow();
    });

    it('should handle edge cases (empty string model)', () => {
      const config = createTestConfig({ model: '' });
      expect(() => getInferenceModel(config)).toThrow('Inference model not configured');
    });
  });

  describe('getInferenceClient', () => {
    it('should create Anthropic client on first call', async () => {
      const config = createTestConfig();
      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should return cached client on subsequent calls (singleton)', async () => {
      const config = createTestConfig();

      const client1 = await getInferenceClient(config);
      const client2 = await getInferenceClient(config);

      expect(client1).toBe(client2);
    });

    it('should throw error if services.inference missing', async () => {
      const config = createConfigWithoutInference();

      await expect(getInferenceClient(config)).rejects.toThrow(
        'services.inference is required in environment config'
      );
    });

    it('should expand environment variable in apiKey', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'env-key-from-var');
      const config = createConfigWithEnvVar('ANTHROPIC_API_KEY');

      // Should not throw - means expansion worked
      const client = await getInferenceClient(config);
      expect(client).toBeDefined();
    });

    it('should throw error if environment variable not set', async () => {
      const config = createConfigWithEnvVar('NONEXISTENT_VAR');

      await expect(getInferenceClient(config)).rejects.toThrow(
        'Environment variable NONEXISTENT_VAR is not set'
      );
    });

    it('should log configuration on initialization', async () => {
      const config = createTestConfig({ model: 'claude-3-opus-20240229' });

      await getInferenceClient(config);

      expect(console.log).toHaveBeenCalledWith('Inference config loaded:', {
        type: 'anthropic',
        model: 'claude-3-opus-20240229',
        endpoint: undefined,
        hasApiKey: true,
      });

      expect(console.log).toHaveBeenCalledWith(
        'Initialized anthropic inference client with model claude-3-opus-20240229'
      );
    });
  });
});
