/**
 * Resource Generation Tests
 *
 * Tests the resource generation functions that use AI to create new resources
 * from topics, including markdown parsing and language handling.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateResourceFromTopic } from '../../generation/resource-generation';
import type { EnvironmentConfig } from '@semiont/core';

// Mock @semiont/inference
vi.mock('@semiont/inference', () => {
  return {
    generateText: vi.fn()
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

  it('should generate resource with title and content', async () => {
    const { generateText } = await import('@semiont/inference');
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      '# Quantum Computing\n\nQuantum computing is a revolutionary technology. It uses quantum mechanics principles.\n\nQuantum computers process information differently than classical computers.'
    );

    const result = await generateResourceFromTopic('Quantum Computing', [], config);

    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('content');
    expect(result.title).toBe('Quantum Computing');
    expect(result.content).toContain('Quantum computing');
  });

  it('should extract title from markdown heading', async () => {
    const { generateText } = await import('@semiont/inference');
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      '# Machine Learning Basics\n\nMachine learning is a subset of AI. It focuses on data-driven learning.\n\nML algorithms improve through experience.'
    );

    const result = await generateResourceFromTopic('Machine Learning', [], config);

    expect(result.title).toBe('Machine Learning Basics');
    expect(result.content).toContain('Machine learning is a subset of AI');
  });

  it('should handle markdown code fences', async () => {
    const { generateText } = await import('@semiont/inference');
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      '```markdown\n# Neural Networks\n\nNeural networks are computational models. They mimic biological neurons.\n\nThey excel at pattern recognition.\n```'
    );

    const result = await generateResourceFromTopic('Neural Networks', [], config);

    expect(result.title).toBe('Neural Networks');
    expect(result.content).toContain('Neural networks are computational models');
    expect(result.content).not.toContain('```');
  });

  it('should include entity types in generation', async () => {
    const { generateText } = await import('@semiont/inference');
    let capturedPrompt = '';
    (generateText as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string, options: any) => {
      capturedPrompt = prompt;
      return '# AI Ethics\n\nAI ethics examines moral implications. It involves people and organizations.\n\nEthical frameworks guide AI development.';
    });

    await generateResourceFromTopic('AI Ethics', ['Person', 'Organization'], config);

    expect(capturedPrompt).toContain('Person');
    expect(capturedPrompt).toContain('Organization');
  });

  it('should handle user prompt', async () => {
    const { generateText } = await import('@semiont/inference');
    let capturedPrompt = '';
    (generateText as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string, options: any) => {
      capturedPrompt = prompt;
      return '# Data Privacy\n\nData privacy protects personal information. Regulations enforce privacy rights.\n\nPrivacy is fundamental.';
    });

    await generateResourceFromTopic(
      'Data Privacy',
      [],
      config,
      'Focus on GDPR compliance'
    );

    expect(capturedPrompt).toContain('GDPR compliance');
  });

  it('should handle non-English locale', async () => {
    const { generateText } = await import('@semiont/inference');
    let capturedPrompt = '';
    (generateText as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string, options: any) => {
      capturedPrompt = prompt;
      return '# Apprentissage Automatique\n\nL\'apprentissage automatique est une branche de l\'IA. Il utilise des données.\n\nLes algorithmes apprennent automatiquement.';
    });

    const result = await generateResourceFromTopic(
      'Machine Learning',
      [],
      config,
      undefined,
      'fr'
    );

    expect(capturedPrompt).toContain('French');
    expect(result.title).toBe('Apprentissage Automatique');
  });

  it('should include generation context when provided', async () => {
    const { generateText } = await import('@semiont/inference');
    let capturedPrompt = '';
    (generateText as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string, options: any) => {
      capturedPrompt = prompt;
      return '# Deep Learning\n\nDeep learning uses neural networks. Multiple layers extract features.\n\nDeep models excel at complex tasks.';
    });

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

    expect(capturedPrompt).toContain('Source document context');
    expect(capturedPrompt).toContain('deep learning');
    expect(capturedPrompt).toContain('Machine learning includes');
  });

  it('should pass temperature and maxTokens to inference', async () => {
    const { generateText } = await import('@semiont/inference');
    let capturedOptions: any;
    (generateText as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string, options: any) => {
      capturedOptions = options;
      return '# Test Resource\n\nTest content here.\n\nMore test content.';
    });

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

    expect(capturedOptions.temperature).toBe(0.9);
    expect(capturedOptions.maxTokens).toBe(1000);
  });

  it('should use default temperature and maxTokens when not provided', async () => {
    const { generateText } = await import('@semiont/inference');
    let capturedOptions: any;
    (generateText as ReturnType<typeof vi.fn>).mockImplementation(async (prompt: string, options: any) => {
      capturedOptions = options;
      return '# Default Settings\n\nUsing default parameters.\n\nGeneration continues.';
    });

    await generateResourceFromTopic('Default Test', [], config);

    expect(capturedOptions.temperature).toBe(0.7);
    expect(capturedOptions.maxTokens).toBe(500);
  });

  it('should handle response without markdown heading', async () => {
    const { generateText } = await import('@semiont/inference');
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      'Just some plain text without a heading. This should still work.\n\nMore content follows.'
    );

    const result = await generateResourceFromTopic('No Heading Topic', [], config);

    // Should use topic as title if no heading found
    expect(result.title).toBe('No Heading Topic');
    expect(result.content).toContain('Just some plain text');
  });

  it('should handle ```md code fence variant', async () => {
    const { generateText } = await import('@semiont/inference');
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      '```md\n# Short Syntax\n\nTesting the md variant.\n\nWorks the same way.\n```'
    );

    const result = await generateResourceFromTopic('Markdown Variant', [], config);

    expect(result.title).toBe('Short Syntax');
    expect(result.content).not.toContain('```md');
  });

  it('should trim whitespace from generated content', async () => {
    const { generateText } = await import('@semiont/inference');
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      '\n\n  # Whitespace Test  \n\nContent with extra spaces.   \n\n  More content.  \n\n'
    );

    const result = await generateResourceFromTopic('Whitespace', [], config);

    expect(result.title).toBe('Whitespace Test');
    // Content should be trimmed but preserve internal structure
    expect(result.content.startsWith('\n\n')).toBe(false);
    expect(result.content.endsWith('\n\n')).toBe(false);
  });
});
