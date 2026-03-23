import { describe, it, expect } from 'vitest';
import { inferenceConfigToGenerator } from '../agent-utils.js';
import type { InferenceConfig } from '../config.js';

describe('inferenceConfigToGenerator', () => {
  it('builds a SoftwareAgent for ollama provider', () => {
    const config: InferenceConfig = { type: 'ollama', model: 'llama3' };
    const agent = inferenceConfigToGenerator('Highlight Worker', config);

    expect(agent['@type']).toBe('SoftwareAgent');
    expect(agent.name).toBe('Highlight Worker / Ollama llama3');
    expect(agent.worker).toBe('Highlight Worker');
    expect(agent.inferenceProvider).toBe('ollama');
    expect(agent.model).toBe('llama3');
  });

  it('builds a SoftwareAgent for anthropic provider', () => {
    const config: InferenceConfig = { type: 'anthropic', model: 'claude-sonnet-4-6' };
    const agent = inferenceConfigToGenerator('Reference Worker', config);

    expect(agent['@type']).toBe('SoftwareAgent');
    expect(agent.name).toBe('Reference Worker / Anthropic claude-sonnet-4-6');
    expect(agent.worker).toBe('Reference Worker');
    expect(agent.inferenceProvider).toBe('anthropic');
    expect(agent.model).toBe('claude-sonnet-4-6');
  });

  it('builds a SoftwareAgent for an unknown provider type', () => {
    // Cast to bypass TypeScript narrowing — tests the fallback branch
    const config = { type: 'openai' as 'ollama', model: 'gpt-4o' };
    const agent = inferenceConfigToGenerator('Assessment Worker', config);

    expect(agent['@type']).toBe('SoftwareAgent');
    expect(agent.name).toBe('Assessment Worker / openai gpt-4o');
    expect(agent.worker).toBe('Assessment Worker');
    expect(agent.inferenceProvider).toBe('openai');
    expect(agent.model).toBe('gpt-4o');
  });

  it('uses workerType alone as name when type is null', () => {
    // Cast to exercise the null branch in the ternary chain
    const config = { type: null as unknown as 'ollama', model: undefined as unknown as string };
    const agent = inferenceConfigToGenerator('Tag Worker', config);

    expect(agent['@type']).toBe('SoftwareAgent');
    expect(agent.name).toBe('Tag Worker');
    expect(agent.worker).toBe('Tag Worker');
  });

  it('includes the workerType string in both name and worker fields', () => {
    const config: InferenceConfig = { type: 'ollama', model: 'mistral' };
    const agent = inferenceConfigToGenerator('Comment Worker', config);

    expect(agent.name).toContain('Comment Worker');
    expect(agent.worker).toBe('Comment Worker');
  });
});
