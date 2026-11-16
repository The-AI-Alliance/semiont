import { describe, it, expect, vi } from 'vitest';
import { createInferenceClient } from '../factory.js';
import type { InferenceClientConfig } from '../factory.js';
import type { Logger } from '@semiont/core';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('@semiont/inference - createInferenceClient', () => {
  it('creates an Anthropic client', () => {
    const config: InferenceClientConfig = {
      type: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'test-key',
    };
    const client = createInferenceClient(config, mockLogger);
    expect(client).toBeDefined();
  });

  it('creates an Ollama client', () => {
    const config: InferenceClientConfig = {
      type: 'ollama',
      model: 'llama3.2',
    };
    const client = createInferenceClient(config, mockLogger);
    expect(client).toBeDefined();
  });

  it('throws for missing Anthropic apiKey', () => {
    const config: InferenceClientConfig = {
      type: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: undefined,
    };
    expect(() => createInferenceClient(config)).toThrow('apiKey is required');
  });

  it('throws for empty Anthropic apiKey', () => {
    const config: InferenceClientConfig = {
      type: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: '',
    };
    expect(() => createInferenceClient(config)).toThrow('apiKey is required');
  });

  it('throws for unsupported type', () => {
    const config = {
      type: 'openai' as 'anthropic',
      model: 'gpt-4',
      apiKey: 'test',
    };
    expect(() => createInferenceClient(config)).toThrow('Unsupported inference client type');
  });
});
