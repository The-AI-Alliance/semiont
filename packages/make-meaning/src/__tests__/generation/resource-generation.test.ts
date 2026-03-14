/**
 * Resource Generation Tests
 *
 * Tests the resource generation functions that use AI to create new resources
 * from topics, including markdown parsing and language handling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateResourceFromTopic } from '@semiont/jobs';
import { MockInferenceClient } from '@semiont/inference';

// Create mock client directly - no need for complex vi.mock since we're passing it directly to functions
const mockInferenceClient = new MockInferenceClient(['']);

describe('generateResourceFromTopic', () => {

  beforeEach(() => {
    // Reset mock client state between tests
    mockInferenceClient.reset();
  });


  it('should generate resource with title and content', async () => {
    mockInferenceClient.setResponses([
      '# Quantum Computing\n\nQuantum computing is a revolutionary technology. It uses quantum mechanics principles.\n\nQuantum computers process information differently than classical computers.'
    ]);

    const result = await generateResourceFromTopic('Quantum Computing', [], mockInferenceClient);

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
    mockInferenceClient.setResponses([
      '# Machine Learning Basics\n\nMachine learning is a subset of AI. It focuses on data-driven learning.\n\nML algorithms improve through experience.'
    ]);

    const result = await generateResourceFromTopic('Machine Learning', [], mockInferenceClient);

    expect(result.title).toBe('Machine Learning Basics');
    expect(result.content).toContain('Machine learning is a subset of AI');
  });

  it('should handle markdown code fences', async () => {
    mockInferenceClient.setResponses([
      '```markdown\n# Neural Networks\n\nNeural networks are computational models. They mimic biological neurons.\n\nThey excel at pattern recognition.\n```'
    ]);

    const result = await generateResourceFromTopic('Neural Networks', [], mockInferenceClient);

    expect(result.title).toBe('Neural Networks');
    expect(result.content).toContain('Neural networks are computational models');
    expect(result.content).not.toContain('```');
  });

  it('should include entity types in generation', async () => {
    mockInferenceClient.setResponses([
      '# AI Ethics\n\nAI ethics examines moral implications. It involves people and organizations.\n\nEthical frameworks guide AI development.'
    ]);

    await generateResourceFromTopic('AI Ethics', ['Person', 'Organization'], mockInferenceClient);

    const capturedPrompt = mockInferenceClient.calls[0].prompt;
    expect(capturedPrompt).toContain('Person');
    expect(capturedPrompt).toContain('Organization');
  });

  it('should handle user prompt', async () => {
    mockInferenceClient.setResponses([
      '# Data Privacy\n\nData privacy protects personal information. Regulations enforce privacy rights.\n\nPrivacy is fundamental.'
    ]);

    await generateResourceFromTopic(
      'Data Privacy',
      [],
      mockInferenceClient,
      'Focus on GDPR compliance'
    );

    const capturedPrompt = mockInferenceClient.calls[0].prompt;
    expect(capturedPrompt).toContain('GDPR compliance');
  });

  it('should handle non-English locale', async () => {
    mockInferenceClient.setResponses([
      '# Apprentissage Automatique\n\nL\'apprentissage automatique est une branche de l\'IA. Il utilise des données.\n\nLes algorithmes apprennent automatiquement.'
    ]);

    const result = await generateResourceFromTopic(
      'Machine Learning',
      [],
      mockInferenceClient,
      undefined,
      'fr'
    );

    const capturedPrompt = mockInferenceClient.calls[0].prompt;
    expect(capturedPrompt).toContain('French');
    // Title comes from topic parameter, not from generated markdown
    expect(result.title).toBe('Machine Learning');
    expect(result.content).toContain('Apprentissage Automatique');
  });

  it('should include generation context when provided', async () => {
    mockInferenceClient.setResponses([
      '# Deep Learning\n\nDeep learning uses neural networks. Multiple layers extract features.\n\nDeep models excel at complex tasks.'
    ]);

    await generateResourceFromTopic(
      'Deep Learning',
      [],
      mockInferenceClient,
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

    const capturedPrompt = mockInferenceClient.calls[0].prompt;
    expect(capturedPrompt).toContain('Source document context');
    expect(capturedPrompt).toContain('deep learning');
    expect(capturedPrompt).toContain('Machine learning includes');
  });

  it('should pass temperature and maxTokens to inference', async () => {
    mockInferenceClient.setResponses([
      '# Test Resource\n\nTest content here.\n\nMore test content.'
    ]);

    await generateResourceFromTopic(
      'Test Topic',
      [],
      mockInferenceClient,
      undefined,
      undefined,
      undefined,
      0.9,
      1000
    );

    const call = mockInferenceClient.calls[0];
    expect(call.temperature).toBe(0.9);
    expect(call.maxTokens).toBe(1000);
  });

  it('should use default temperature and maxTokens when not provided', async () => {
    mockInferenceClient.setResponses([
      '# Default Settings\n\nUsing default parameters.\n\nGeneration continues.'
    ]);

    await generateResourceFromTopic('Default Test', [], mockInferenceClient);

    const call = mockInferenceClient.calls[0];
    expect(call.temperature).toBe(0.7);
    expect(call.maxTokens).toBe(500);
  });

  it('should handle response without markdown heading', async () => {
    mockInferenceClient.setResponses([
      'Just some plain text without a heading. This should still work.\n\nMore content follows.'
    ]);

    const result = await generateResourceFromTopic('No Heading Topic', [], mockInferenceClient);

    // Should use topic as title if no heading found
    expect(result.title).toBe('No Heading Topic');
    expect(result.content).toContain('Just some plain text');
  });

  it('should handle ```md code fence variant', async () => {
    mockInferenceClient.setResponses([
      '```md\n# Short Syntax\n\nTesting the md variant.\n\nWorks the same way.\n```'
    ]);

    const result = await generateResourceFromTopic('Markdown Variant', [], mockInferenceClient);

    // Title comes from topic parameter
    expect(result.title).toBe('Markdown Variant');
    // Code fence should be stripped from content
    expect(result.content).not.toContain('```md');
    expect(result.content).toContain('Short Syntax');
  });

  it('should trim whitespace from generated content', async () => {
    mockInferenceClient.setResponses([
      '\n\n  # Whitespace Test  \n\nContent with extra spaces.   \n\n  More content.  \n\n'
    ]);

    const result = await generateResourceFromTopic('Whitespace', [], mockInferenceClient);

    // Title comes from topic parameter
    expect(result.title).toBe('Whitespace');
    // Content should be trimmed but preserve internal structure
    expect(result.content.startsWith('\n\n')).toBe(false);
    expect(result.content.endsWith('\n\n')).toBe(false);
    expect(result.content).toContain('Whitespace Test');
  });

  describe('graph context in prompt', () => {
    it('should include connections in prompt', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Zeus',
        ['Person'],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: 'before', selected: 'Zeus', after: 'after' },
          graphContext: {
            connections: [
              { resourceId: 'r1', resourceName: 'Mount Olympus', entityTypes: ['Location'], bidirectional: false },
              { resourceId: 'r2', resourceName: 'Hera', entityTypes: ['Person', 'Deity'], bidirectional: true },
            ],
            citedByCount: 0,
          },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).toContain('Knowledge graph context');
      expect(prompt).toContain('Connected resources');
      expect(prompt).toContain('Mount Olympus (Location)');
      expect(prompt).toContain('Hera (Person, Deity)');
    });

    it('should include citedBy in prompt', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Prometheus',
        [],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: '', selected: 'Prometheus', after: '' },
          graphContext: {
            connections: [],
            citedByCount: 3,
            citedBy: [
              { resourceId: 'c1', resourceName: 'Prometheus Bound' },
              { resourceId: 'c2', resourceName: 'Theogony' },
            ],
          },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).toContain('cited by 3 other resources');
      expect(prompt).toContain('Prometheus Bound');
      expect(prompt).toContain('Theogony');
    });

    it('should include singular "resource" for citedByCount of 1', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Icarus',
        [],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: '', selected: 'Icarus', after: '' },
          graphContext: {
            connections: [],
            citedByCount: 1,
            citedBy: [{ resourceId: 'c1', resourceName: 'Metamorphoses' }],
          },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).toContain('cited by 1 other resource');
      expect(prompt).not.toContain('resources');
    });

    it('should include siblingEntityTypes in prompt', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Athens',
        ['Location'],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: '', selected: 'Athens', after: '' },
          graphContext: {
            connections: [],
            citedByCount: 0,
            siblingEntityTypes: ['Person', 'Event', 'Organization'],
          },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).toContain('Related entity types');
      expect(prompt).toContain('Person');
      expect(prompt).toContain('Event');
      expect(prompt).toContain('Organization');
    });

    it('should include inferredRelationshipSummary in prompt', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      const summary = 'This passage about Zeus relates to the mythology section, connecting to several deity resources.';
      await generateResourceFromTopic(
        'Zeus',
        [],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: '', selected: 'Zeus', after: '' },
          graphContext: {
            connections: [],
            citedByCount: 0,
            inferredRelationshipSummary: summary,
          },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).toContain('Relationship summary');
      expect(prompt).toContain(summary);
    });

    it('should omit graph context section when graphContext has no content', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Orphan',
        [],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: '', selected: 'Orphan', after: '' },
          graphContext: {
            connections: [],
            citedByCount: 0,
          },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).not.toContain('Knowledge graph context');
    });

    it('should omit graph context section when graphContext is undefined', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'NoGraph',
        [],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: '', selected: 'NoGraph', after: '' },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).not.toContain('Knowledge graph context');
    });

    it('should handle connections without entityTypes', async () => {
      mockInferenceClient.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Topic',
        [],
        mockInferenceClient,
        undefined,
        undefined,
        {
          sourceContext: { before: '', selected: 'Topic', after: '' },
          graphContext: {
            connections: [
              { resourceId: 'r1', resourceName: 'Untitled', bidirectional: false },
            ],
            citedByCount: 0,
          },
        },
      );

      const prompt = mockInferenceClient.calls[0].prompt;
      expect(prompt).toContain('Untitled');
      // Should not crash or include empty parens
      expect(prompt).not.toContain('()');
    });
  });
});
