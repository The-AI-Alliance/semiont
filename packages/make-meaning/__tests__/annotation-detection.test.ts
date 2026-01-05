import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnotationDetection } from '../src/annotation-detection';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Mock dependencies
vi.mock('../src/resource-context', () => ({
  ResourceContext: {
    getResourceMetadata: vi.fn(),
  },
}));

vi.mock('@semiont/content', () => ({
  FilesystemRepresentationStore: vi.fn(),
}));

vi.mock('@semiont/inference', () => ({
  generateText: vi.fn(),
  MotivationPrompts: {
    buildCommentPrompt: vi.fn(),
    buildHighlightPrompt: vi.fn(),
    buildAssessmentPrompt: vi.fn(),
    buildTagPrompt: vi.fn(),
  },
  MotivationParsers: {
    parseComments: vi.fn(),
    parseHighlights: vi.fn(),
    parseAssessments: vi.fn(),
    parseTags: vi.fn(),
    validateTagOffsets: vi.fn(),
  },
}));

vi.mock('@semiont/ontology', () => ({
  getTagSchema: vi.fn(),
}));

import { ResourceContext } from '../src/resource-context';
import { FilesystemRepresentationStore } from '@semiont/content';
import { generateText, MotivationPrompts, MotivationParsers } from '@semiont/inference';
import { getTagSchema } from '@semiont/ontology';

describe('AnnotationDetection', () => {
  let mockConfig: EnvironmentConfig;
  let mockRepStore: any;

  const mockResource: ResourceDescriptor = {
    '@context': 'https://schema.org/',
    '@id': 'http://localhost:4000/resources/test-123',
    name: 'Test Document',
    archived: false,
    entityTypes: ['Document'],
    creationMethod: 'api',
    dateCreated: '2024-01-01T00:00:00Z',
    representations: [
      {
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 100,
        rel: 'original',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        backend: { publicURL: 'http://localhost:4000' },
        openai: {
          apiKey: 'test-key',
          model: 'gpt-4o-mini',
        },
      },
      storage: {
        base: '/test/storage',
      },
      _metadata: { projectRoot: '/test' },
    } as EnvironmentConfig;

    mockRepStore = {
      retrieve: vi.fn(),
    };

    vi.mocked(FilesystemRepresentationStore).mockImplementation(() => mockRepStore);
  });

  describe('detectComments', () => {
    const content = 'This is a test document with some content.';
    const mockComments = [
      {
        exact: 'test document',
        start: 10,
        end: 23,
        prefix: 'This is a ',
        suffix: ' with some',
        comment: 'This is a placeholder document for testing.',
      },
    ];

    it('should detect comments in resource', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(MotivationPrompts.buildCommentPrompt).mockReturnValue('comment prompt');
      vi.mocked(generateText).mockResolvedValue('AI response');
      vi.mocked(MotivationParsers.parseComments).mockReturnValue(mockComments);

      const result = await AnnotationDetection.detectComments(
        'test-123' as ResourceId,
        mockConfig,
        'Focus on technical details',
        'educational',
        0.7
      );

      expect(result).toEqual(mockComments);
      expect(MotivationPrompts.buildCommentPrompt).toHaveBeenCalledWith(
        content,
        'Focus on technical details',
        'educational',
        0.7
      );
      expect(generateText).toHaveBeenCalledWith('comment prompt', mockConfig);
      expect(MotivationParsers.parseComments).toHaveBeenCalledWith('AI response', content);
    });

    it('should handle default parameters', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(MotivationPrompts.buildCommentPrompt).mockReturnValue('prompt');
      vi.mocked(generateText).mockResolvedValue('response');
      vi.mocked(MotivationParsers.parseComments).mockReturnValue([]);

      await AnnotationDetection.detectComments('test-123' as ResourceId, mockConfig);

      expect(MotivationPrompts.buildCommentPrompt).toHaveBeenCalledWith(
        content,
        undefined,
        undefined,
        undefined
      );
    });

    it('should throw error when resource not found', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(null);

      await expect(
        AnnotationDetection.detectComments('nonexistent' as ResourceId, mockConfig)
      ).rejects.toThrow('Resource not found');
    });

    it('should throw error when resource has no content', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue({
        ...mockResource,
        representations: [],
      });

      await expect(
        AnnotationDetection.detectComments('test-123' as ResourceId, mockConfig)
      ).rejects.toThrow('Resource has no content');
    });
  });

  describe('detectHighlights', () => {
    const content = 'Key concept: machine learning is a subset of AI.';
    const mockHighlights = [
      {
        exact: 'machine learning',
        start: 13,
        end: 29,
        prefix: 'Key concept: ',
        suffix: ' is a subset',
      },
    ];

    it('should detect highlights in resource', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(MotivationPrompts.buildHighlightPrompt).mockReturnValue('highlight prompt');
      vi.mocked(generateText).mockResolvedValue('AI response');
      vi.mocked(MotivationParsers.parseHighlights).mockReturnValue(mockHighlights);

      const result = await AnnotationDetection.detectHighlights(
        'test-123' as ResourceId,
        mockConfig,
        'Find key definitions',
        0.5
      );

      expect(result).toEqual(mockHighlights);
      expect(MotivationPrompts.buildHighlightPrompt).toHaveBeenCalledWith(
        content,
        'Find key definitions',
        0.5
      );
    });

    it('should return empty array when no highlights found', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(MotivationPrompts.buildHighlightPrompt).mockReturnValue('prompt');
      vi.mocked(generateText).mockResolvedValue('response');
      vi.mocked(MotivationParsers.parseHighlights).mockReturnValue([]);

      const result = await AnnotationDetection.detectHighlights(
        'test-123' as ResourceId,
        mockConfig
      );

      expect(result).toEqual([]);
    });
  });

  describe('detectAssessments', () => {
    const content = 'This explanation could be clearer.';
    const mockAssessments = [
      {
        exact: 'This explanation',
        start: 0,
        end: 16,
        prefix: '',
        suffix: ' could be',
        assessment: 'The explanation lacks concrete examples to illustrate the concept.',
      },
    ];

    it('should detect assessments in resource', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(MotivationPrompts.buildAssessmentPrompt).mockReturnValue('assessment prompt');
      vi.mocked(generateText).mockResolvedValue('AI response');
      vi.mocked(MotivationParsers.parseAssessments).mockReturnValue(mockAssessments);

      const result = await AnnotationDetection.detectAssessments(
        'test-123' as ResourceId,
        mockConfig,
        'Evaluate clarity',
        'constructive',
        0.6
      );

      expect(result).toEqual(mockAssessments);
      expect(MotivationPrompts.buildAssessmentPrompt).toHaveBeenCalledWith(
        content,
        'Evaluate clarity',
        'constructive',
        0.6
      );
    });

    it('should handle different tone values', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(MotivationPrompts.buildAssessmentPrompt).mockReturnValue('prompt');
      vi.mocked(generateText).mockResolvedValue('response');
      vi.mocked(MotivationParsers.parseAssessments).mockReturnValue([]);

      await AnnotationDetection.detectAssessments(
        'test-123' as ResourceId,
        mockConfig,
        undefined,
        'critical'
      );

      expect(MotivationPrompts.buildAssessmentPrompt).toHaveBeenCalledWith(
        content,
        undefined,
        'critical',
        undefined
      );
    });
  });

  describe('detectTags', () => {
    const content = 'Issue: The defendant violated the statute. Rule: Section 123 states...';
    const mockSchema = {
      id: 'irac',
      name: 'IRAC',
      description: 'Legal reasoning framework',
      domain: 'legal',
      tags: [
        {
          name: 'issue',
          description: 'The legal question',
          examples: ['What law was violated?', 'Is there liability?'],
        },
      ],
    };

    const mockTags = [
      {
        exact: 'Issue: The defendant violated the statute.',
        start: 0,
        end: 42,
        prefix: '',
        suffix: ' Rule: Section',
      },
    ];

    const mockValidatedTags = [
      {
        ...mockTags[0],
        category: 'issue',
      },
    ];

    it('should detect tags using schema', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(getTagSchema).mockReturnValue(mockSchema);
      vi.mocked(MotivationPrompts.buildTagPrompt).mockReturnValue('tag prompt');
      vi.mocked(generateText).mockResolvedValue('AI response');
      vi.mocked(MotivationParsers.parseTags).mockReturnValue(mockTags);
      vi.mocked(MotivationParsers.validateTagOffsets).mockReturnValue(mockValidatedTags);

      const result = await AnnotationDetection.detectTags(
        'test-123' as ResourceId,
        mockConfig,
        'irac',
        'issue'
      );

      expect(result).toEqual(mockValidatedTags);
      expect(getTagSchema).toHaveBeenCalledWith('irac');
      expect(MotivationPrompts.buildTagPrompt).toHaveBeenCalledWith(
        content,
        'issue',
        'IRAC',
        'Legal reasoning framework',
        'legal',
        'The legal question',
        ['What law was violated?', 'Is there liability?']
      );
      expect(MotivationParsers.validateTagOffsets).toHaveBeenCalledWith(
        mockTags,
        content,
        'issue'
      );
    });

    it('should throw error when schema not found', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(getTagSchema).mockReturnValue(null);

      await expect(
        AnnotationDetection.detectTags('test-123' as ResourceId, mockConfig, 'invalid', 'category')
      ).rejects.toThrow('Tag schema not found');
    });

    it('should throw error when category not in schema', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(getTagSchema).mockReturnValue(mockSchema);

      await expect(
        AnnotationDetection.detectTags('test-123' as ResourceId, mockConfig, 'irac', 'invalid')
      ).rejects.toThrow('Category "invalid" not found in schema');
    });

    it('should return empty array when no tags found', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(getTagSchema).mockReturnValue(mockSchema);
      vi.mocked(MotivationPrompts.buildTagPrompt).mockReturnValue('prompt');
      vi.mocked(generateText).mockResolvedValue('response');
      vi.mocked(MotivationParsers.parseTags).mockReturnValue([]);
      vi.mocked(MotivationParsers.validateTagOffsets).mockReturnValue([]);

      const result = await AnnotationDetection.detectTags(
        'test-123' as ResourceId,
        mockConfig,
        'irac',
        'issue'
      );

      expect(result).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should handle AI generation errors gracefully', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from('content'));
      vi.mocked(MotivationPrompts.buildCommentPrompt).mockReturnValue('prompt');
      vi.mocked(generateText).mockRejectedValue(new Error('API error'));

      await expect(
        AnnotationDetection.detectComments('test-123' as ResourceId, mockConfig)
      ).rejects.toThrow('API error');
    });

    it('should handle parsing errors gracefully', async () => {
      vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from('content'));
      vi.mocked(MotivationPrompts.buildHighlightPrompt).mockReturnValue('prompt');
      vi.mocked(generateText).mockResolvedValue('response');
      vi.mocked(MotivationParsers.parseHighlights).mockImplementation(() => {
        throw new Error('Parse error');
      });

      await expect(
        AnnotationDetection.detectHighlights('test-123' as ResourceId, mockConfig)
      ).rejects.toThrow('Parse error');
    });
  });
});
