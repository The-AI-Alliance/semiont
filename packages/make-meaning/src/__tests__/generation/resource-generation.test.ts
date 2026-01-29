/**
 * Resource Generation Tests
 *
 * Tests the resource generation functions that use AI to create new resources
 * from topics, including markdown parsing and language handling.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateResourceFromTopic } from '../../generation/resource-generation';
import type { EnvironmentConfig } from '@semiont/core';

// Mock @semiont/inference
const mockInferenceClient = vi.hoisted(() => ({ client: null as any }));

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockInferenceClient.client = new MockInferenceClient(['']);

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
    MockInferenceClient
  };
});

describe('generateResourceFromTopic', () => {
  let config: EnvironmentConfig;

  beforeAll(() => {
    config = {
      services: {
        inference: {
          platform: { type: 'external' },
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          endpoint: 'https://api.anthropic.com',
          apiKey: 'test-api-key'
        }
      },
      site: {
        siteName: 'Test Site',
        domain: 'localhost:3000',
        adminEmail: 'admin@test.local',
        oauthAllowedDomains: ['test.local']
      },
      _metadata: {
        environment: 'test',
        projectRoot: '/tmp/test'
      }
    } as EnvironmentConfig;
  });

  beforeEach(() => {
    mockInferenceClient.client.reset();
  });

  it('should generate resource with title and content', async () => {
    mockInferenceClient.client.setResponses([
      '# Quantum Computing\n\nQuantum computing is a revolutionary technology. It uses quantum mechanics principles.\n\nQuantum computers process information differently than classical computers.'
    ]);

    const result = await generateResourceFromTopic('Quantum Computing', [], config);

    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('content');
    expect(result.title).toBe('Quantum Computing');
    expect(result.content).toContain('Quantum computing');
  });

  // NOTE: Currently the function uses the topic parameter as the title rather than
  // extracting it from markdown. This is intentional per the comment in resource-generation.ts.
  // Title extraction from markdown could be a reasonable alternative to pursue in the future
  // if we want AI-generated titles to override user-provided topics.
  it.skip('should extract title from markdown heading', async () => {
    mockInferenceClient.client.setResponses([
      '# Machine Learning Basics\n\nMachine learning is a subset of AI. It focuses on data-driven learning.\n\nML algorithms improve through experience.'
    ]);

    const result = await generateResourceFromTopic('Machine Learning', [], config);

    expect(result.title).toBe('Machine Learning Basics');
    expect(result.content).toContain('Machine learning is a subset of AI');
  });

  it('should handle markdown code fences', async () => {
    mockInferenceClient.client.setResponses([
      '```markdown\n# Neural Networks\n\nNeural networks are computational models. They mimic biological neurons.\n\nThey excel at pattern recognition.\n```'
    ]);

    const result = await generateResourceFromTopic('Neural Networks', [], config);

    expect(result.title).toBe('Neural Networks');
    expect(result.content).toContain('Neural networks are computational models');
    expect(result.content).not.toContain('```');
  });

  it('should include entity types in generation', async () => {
    mockInferenceClient.client.setResponses([
      '# AI Ethics\n\nAI ethics examines moral implications. It involves people and organizations.\n\nEthical frameworks guide AI development.'
    ]);

    await generateResourceFromTopic('AI Ethics', ['Person', 'Organization'], config);

    const capturedPrompt = mockInferenceClient.client.calls[0].prompt;
    expect(capturedPrompt).toContain('Person');
    expect(capturedPrompt).toContain('Organization');
  });

  it('should handle user prompt', async () => {
    mockInferenceClient.client.setResponses([
      '# Data Privacy\n\nData privacy protects personal information. Regulations enforce privacy rights.\n\nPrivacy is fundamental.'
    ]);

    await generateResourceFromTopic(
      'Data Privacy',
      [],
      config,
      'Focus on GDPR compliance'
    );

    const capturedPrompt = mockInferenceClient.client.calls[0].prompt;
    expect(capturedPrompt).toContain('GDPR compliance');
  });

  it('should handle non-English locale', async () => {
    mockInferenceClient.client.setResponses([
      '# Apprentissage Automatique\n\nL\'apprentissage automatique est une branche de l\'IA. Il utilise des données.\n\nLes algorithmes apprennent automatiquement.'
    ]);

    const result = await generateResourceFromTopic(
      'Machine Learning',
      [],
      config,
      undefined,
      'fr'
    );

    const capturedPrompt = mockInferenceClient.client.calls[0].prompt;
    expect(capturedPrompt).toContain('French');
    // Title comes from topic parameter, not from generated markdown
    expect(result.title).toBe('Machine Learning');
    expect(result.content).toContain('Apprentissage Automatique');
  });

  it('should include generation context when provided', async () => {
    mockInferenceClient.client.setResponses([
      '# Deep Learning\n\nDeep learning uses neural networks. Multiple layers extract features.\n\nDeep models excel at complex tasks.'
    ]);

    await generateResourceFromTopic(
      'Deep Learning',
      [],
      config,
      undefined,
      undefined,
      {
        sourceContext: {
          before: 'Machine learning includes',
          selected: 'deep learning',
          after: 'as a powerful technique'
        }
      }
    );

    const capturedPrompt = mockInferenceClient.client.calls[0].prompt;
    expect(capturedPrompt).toContain('Source document context');
    expect(capturedPrompt).toContain('deep learning');
    expect(capturedPrompt).toContain('Machine learning includes');
  });

  it('should pass temperature and maxTokens to inference', async () => {
    mockInferenceClient.client.setResponses([
      '# Test Resource\n\nTest content here.\n\nMore test content.'
    ]);

    await generateResourceFromTopic(
      'Test Topic',
      [],
      config,
      undefined,
      undefined,
      undefined,
      0.9,
      1000
    );

    const call = mockInferenceClient.client.calls[0];
    expect(call.temperature).toBe(0.9);
    expect(call.maxTokens).toBe(1000);
  });

  it('should use default temperature and maxTokens when not provided', async () => {
    mockInferenceClient.client.setResponses([
      '# Default Settings\n\nUsing default parameters.\n\nGeneration continues.'
    ]);

    await generateResourceFromTopic('Default Test', [], config);

    const call = mockInferenceClient.client.calls[0];
    expect(call.temperature).toBe(0.7);
    expect(call.maxTokens).toBe(500);
  });

  it('should handle response without markdown heading', async () => {
    mockInferenceClient.client.setResponses([
      'Just some plain text without a heading. This should still work.\n\nMore content follows.'
    ]);

    const result = await generateResourceFromTopic('No Heading Topic', [], config);

    // Should use topic as title if no heading found
    expect(result.title).toBe('No Heading Topic');
    expect(result.content).toContain('Just some plain text');
  });

  it('should handle ```md code fence variant', async () => {
    mockInferenceClient.client.setResponses([
      '```md\n# Short Syntax\n\nTesting the md variant.\n\nWorks the same way.\n```'
    ]);

    const result = await generateResourceFromTopic('Markdown Variant', [], config);

    // Title comes from topic parameter
    expect(result.title).toBe('Markdown Variant');
    // Code fence should be stripped from content
    expect(result.content).not.toContain('```md');
    expect(result.content).toContain('Short Syntax');
  });

  it('should trim whitespace from generated content', async () => {
    mockInferenceClient.client.setResponses([
      '\n\n  # Whitespace Test  \n\nContent with extra spaces.   \n\n  More content.  \n\n'
    ]);

    const result = await generateResourceFromTopic('Whitespace', [], config);

    // Title comes from topic parameter
    expect(result.title).toBe('Whitespace');
    // Content should be trimmed but preserve internal structure
    expect(result.content.startsWith('\n\n')).toBe(false);
    expect(result.content.endsWith('\n\n')).toBe(false);
    expect(result.content).toContain('Whitespace Test');
  });
});
