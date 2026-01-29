import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoist the mock to ensure it's available in the mock factory
const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation((config: any) => {
      console.log('[INTEGRATION MOCK] Creating Anthropic client with', { apiKey: config?.apiKey });
      return {
        apiKey: config?.apiKey,
        baseURL: config?.baseURL,
        messages: {
          create: mockCreate,
        },
      };
    }),
  };
});

import { generateText, resetInferenceClient } from '../factory.js';
import { createTestConfig } from './helpers/mock-config.js';
import {
  createMockTextResponse,
  createMockEmptyResponse,
  createMockMultiBlockResponse,
} from './helpers/mock-anthropic.js';

describe('@semiont/inference - integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetInferenceClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetInferenceClient();
  });

  describe('generateText', () => {
    it('should make inference call with correct parameters', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Test response'));
      const config = createTestConfig();

      await generateText('Test prompt', config, 1000, 0.8);

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        temperature: 0.8,
        messages: [
          {
            role: 'user',
            content: 'Test prompt',
          },
        ],
      });
    });

    it('should pass prompt to Anthropic API', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('My custom prompt', config);

      const call = mockCreate.mock.calls[0][0];
      expect(call.messages[0].content).toBe('My custom prompt');
    });

    it('should use configured model from config', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig({ model: 'claude-3-opus-20240229' });

      await generateText('Test', config);

      expect(mockCreate.mock.calls[0][0].model).toBe('claude-3-opus-20240229');
    });

    it('should use provided maxTokens parameter', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config, 2000);

      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(2000);
    });

    it('should use provided temperature parameter', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config, 500, 0.5);

      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.5);
    });

    it('should default maxTokens to 500', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config);

      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(500);
    });

    it('should default temperature to 0.7', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config);

      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.7);
    });

    it('should extract text content from response', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Expected text content'));
      const config = createTestConfig();

      const result = await generateText('Test', config);

      expect(result).toBe('Expected text content');
    });

    it('should throw error if no text content in response', async () => {
      mockCreate.mockResolvedValue(createMockEmptyResponse());
      const config = createTestConfig();

      await expect(generateText('Test', config)).rejects.toThrow(
        'No text content in inference response'
      );
    });

    it('should handle multiple content blocks', async () => {
      mockCreate.mockResolvedValue(createMockMultiBlockResponse(['First block', 'Second block']));
      const config = createTestConfig();

      const result = await generateText('Test', config);

      // Should return the first text block
      expect(result).toBe('First block');
    });

    it('should reuse singleton client', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response 1'));
      const config = createTestConfig();

      await generateText('First call', config);
      await generateText('Second call', config);

      // Both calls should use the same client instance
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should log prompt length and parameters', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test prompt', config, 1000, 0.9);

      expect(console.log).toHaveBeenCalledWith(
        'generateText called with prompt length:',
        11,
        'maxTokens:',
        1000,
        'temp:',
        0.9
      );
    });

    it('should log response content blocks', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config);

      expect(console.log).toHaveBeenCalledWith('Inference response received, content blocks:', 1);
    });

    it('should handle API errors gracefully', async () => {
      const apiError = new Error('API rate limit exceeded');
      mockCreate.mockRejectedValue(apiError);
      const config = createTestConfig();

      await expect(generateText('Test', config)).rejects.toThrow('API rate limit exceeded');
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network timeout');
      mockCreate.mockRejectedValue(networkError);
      const config = createTestConfig();

      await expect(generateText('Test', config)).rejects.toThrow('Network timeout');
    });
  });
});
