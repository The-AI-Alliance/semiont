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

// ── Detection-consumption capabilities (OLLAMA-DETECTION-TESTING, ruled
// 2026-09-05) ─────────────────────────────────────────────────────────────
//
// @semiont/jobs is written in terms of the InferenceClient contract and does
// NO provider-specific switching (user architecture ruling): whatever varies
// by provider is DECLARED here, per implementation, like `maxConcurrency`.
// These pin the declarations so a new provider must take a position and an
// edit to one is deliberate.
import { AnthropicInferenceClient, OllamaInferenceClient, MockInferenceClient } from '../index';

describe('per-provider detection capabilities', () => {
  it('every REAL provider count-verifies detection yield — Anthropic included (user ruling 2026-09-05)', () => {
    // The verifier was first scoped to where collapse was MEASURED (local
    // models). Overruled: unverified completeness is not a savings — "no
    // observed collapse on Anthropic" was absence-of-looking, and a ~2×
    // Person-yield discrepancy between sonnet and gemma on the same document
    // stands unexplained. The extra billed input is the accepted cost.
    expect(new AnthropicInferenceClient('key', 'model').verifyDetectionYield).toBe(true);
    expect(new OllamaInferenceClient('model').verifyDetectionYield).toBe(true);
  });

  it('the mock does NOT verify by default — deterministic tests opt in explicitly', () => {
    expect(new MockInferenceClient().verifyDetectionYield).toBe(false);
  });
});
