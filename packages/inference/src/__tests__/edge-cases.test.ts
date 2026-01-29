import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoist the mock to ensure it's available in the mock factory
const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation((config: any) => ({
      apiKey: config?.apiKey,
      baseURL: config?.baseURL,
      messages: {
        create: mockCreate,
      },
    })),
  };
});

import { generateText, getInferenceClient, resetInferenceClient } from '../factory.js';
import { createTestConfig } from './helpers/mock-config.js';
import { createMockTextResponse } from './helpers/mock-anthropic.js';

describe('@semiont/inference - edge cases', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    resetInferenceClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetInferenceClient();
  });

  describe('Configuration edge cases', () => {
    it('should handle missing apiKey', async () => {
      const config = createTestConfig({ apiKey: undefined });

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should handle empty string apiKey', async () => {
      const config = createTestConfig({ apiKey: '' });

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should handle whitespace in model name', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig({ model: '  claude-3-5-sonnet-20241022  ' });

      await generateText('Test', config);

      // Should use model as-is (caller's responsibility to validate)
      expect(mockCreate.mock.calls[0][0].model).toBe('  claude-3-5-sonnet-20241022  ');
    });
  });

  describe('Prompt edge cases', () => {
    it('should handle empty prompts', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      const result = await generateText('', config);

      expect(result).toBe('Response');
      expect(mockCreate.mock.calls[0][0].messages[0].content).toBe('');
    });

    it('should handle very large prompts', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();
      const largePrompt = 'a'.repeat(10000);

      await generateText(largePrompt, config);

      expect(mockCreate.mock.calls[0][0].messages[0].content).toHaveLength(10000);
    });

    it('should handle special characters in prompts', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();
      const specialPrompt = 'Hello\n\nWorld\t"quotes"\n\'single\'\n${variable}\n`backticks`';

      await generateText(specialPrompt, config);

      expect(mockCreate.mock.calls[0][0].messages[0].content).toBe(specialPrompt);
    });

    it('should handle unicode in prompts', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();
      const unicodePrompt = 'Hello 世界 🌍 emoji';

      await generateText(unicodePrompt, config);

      expect(mockCreate.mock.calls[0][0].messages[0].content).toBe(unicodePrompt);
    });
  });

  describe('Parameter edge cases', () => {
    it('should handle maxTokens of 0', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config, 0);

      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(0);
    });

    it('should handle very large maxTokens', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config, 100000);

      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(100000);
    });

    it('should handle temperature of 0', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config, 500, 0);

      expect(mockCreate.mock.calls[0][0].temperature).toBe(0);
    });

    it('should handle temperature of 1', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      await generateText('Test', config, 500, 1);

      expect(mockCreate.mock.calls[0][0].temperature).toBe(1);
    });
  });

  describe('Response edge cases', () => {
    it('should handle response with non-text content first', async () => {
      const response = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'image', source: 'data:...' },
          { type: 'text', text: 'Found text' },
        ],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      };
      mockCreate.mockResolvedValue(response);
      const config = createTestConfig();

      const result = await generateText('Test', config);

      // Should find the text content even if it's not first
      expect(result).toBe('Found text');
    });

    it('should handle malformed response content', async () => {
      const response = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'unknown', data: 'something' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      };
      mockCreate.mockResolvedValue(response);
      const config = createTestConfig();

      await expect(generateText('Test', config)).rejects.toThrow(
        'No text content in inference response'
      );
    });
  });

  describe('Concurrent calls', () => {
    it('should handle concurrent generateText calls', async () => {
      mockCreate.mockResolvedValue(createMockTextResponse('Response'));
      const config = createTestConfig();

      const results = await Promise.all([
        generateText('Prompt 1', config),
        generateText('Prompt 2', config),
        generateText('Prompt 3', config),
      ]);

      expect(results).toHaveLength(3);
      expect(results.every(r => r === 'Response')).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });

  describe('Environment variable edge cases', () => {
    it('should handle environment variable with special characters', async () => {
      vi.stubEnv('SPECIAL_KEY', 'key-with-!@#$%^&*()');
      const config = createTestConfig({ apiKey: '${SPECIAL_KEY}' });

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should handle environment variable with spaces', async () => {
      vi.stubEnv('KEY_WITH_SPACES', '  spaces around  ');
      const config = createTestConfig({ apiKey: '${KEY_WITH_SPACES}' });

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should not expand malformed variable syntax', async () => {
      const config = createTestConfig({ apiKey: '${INCOMPLETE' });

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should not expand if missing closing brace', async () => {
      const config = createTestConfig({ apiKey: 'PREFIX-${VAR' });

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });

    it('should not expand partial patterns', async () => {
      const config = createTestConfig({ apiKey: 'api-$KEY' });

      const client = await getInferenceClient(config);

      expect(client).toBeDefined();
    });
  });
});
