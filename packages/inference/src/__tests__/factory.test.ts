import { describe, it, expect } from 'vitest';
import { getInferenceModel } from '../factory.js';

describe('@semiont/inference - factory', () => {
  describe('getInferenceModel', () => {
    it('should return the configured model', () => {
      const config: any = {
        services: {
          inference: {
            type: 'anthropic',
            model: 'claude-3-5-sonnet-20241022',
            apiKey: 'test-key'
          }
        }
      };

      const model = getInferenceModel(config);
      expect(model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should throw error if model is not configured', () => {
      const config: any = {
        services: {
          inference: {
            type: 'anthropic',
            apiKey: 'test-key'
          }
        }
      };

      expect(() => getInferenceModel(config)).toThrow('Inference model not configured');
    });

    it('should throw error if inference config is missing', () => {
      const config: any = {
        services: {}
      };

      expect(() => getInferenceModel(config)).toThrow();
    });
  });
});
