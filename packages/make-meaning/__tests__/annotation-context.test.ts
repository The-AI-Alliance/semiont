import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnotationContext } from '../src/annotation-context';
import type { EnvironmentConfig, ResourceId, AnnotationId } from '@semiont/core';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Mock dependencies
vi.mock('@semiont/event-sourcing', () => ({
  FilesystemViewStorage: vi.fn(),
}));

vi.mock('@semiont/content', () => ({
  FilesystemRepresentationStore: vi.fn(),
}));

vi.mock('@semiont/inference', () => ({
  generateText: vi.fn(),
}));

import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { generateText } from '@semiont/inference';

describe('AnnotationContext', () => {
  let mockConfig: EnvironmentConfig;
  let mockViewStorage: any;
  let mockRepStore: any;

  const mockResource: ResourceDescriptor = {
    '@context': 'https://schema.org/',
    '@id': 'http://localhost:4000/resources/test-123',
    name: 'Test Resource',
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

  const mockAnnotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: 'http://localhost:4000/annotations/anno-1',
    motivation: 'commenting',
    target: {
      type: 'SpecificResource',
      source: 'http://localhost:4000/resources/test-123',
      selector: {
        type: 'TextPositionSelector',
        start: 0,
        end: 10,
      },
    },
    body: {
      type: 'TextualBody',
      value: 'This is a comment',
      format: 'text/plain',
    },
    created: '2024-01-01T00:00:00Z',
    modified: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        backend: { publicURL: 'http://localhost:4000' },
        filesystem: { path: '/test/data' },
      },
      storage: {
        base: '/test/storage',
      },
      _metadata: { projectRoot: '/test' },
    } as EnvironmentConfig;

    mockViewStorage = {
      getResourceMetadata: vi.fn(),
      getResourceAnnotations: vi.fn(),
      getAllAnnotations: vi.fn(),
      getAnnotation: vi.fn(),
      listAnnotations: vi.fn(),
      resourceExists: vi.fn(),
      getResourceStats: vi.fn(),
    };

    mockRepStore = {
      retrieve: vi.fn(),
    };

    vi.mocked(FilesystemViewStorage).mockImplementation(() => mockViewStorage);
    vi.mocked(FilesystemRepresentationStore).mockImplementation(() => mockRepStore);
  });

  describe('getResourceAnnotations', () => {
    const mockResourceAnnotations = {
      comments: [mockAnnotation],
      highlights: [],
      tags: [],
      links: [],
      assessments: [],
    };

    it('should return organized annotations for a resource', async () => {
      mockViewStorage.getResourceAnnotations.mockResolvedValue(mockResourceAnnotations);

      const result = await AnnotationContext.getResourceAnnotations('test-123' as ResourceId, mockConfig);

      expect(result).toEqual(mockResourceAnnotations);
      expect(mockViewStorage.getResourceAnnotations).toHaveBeenCalledWith('test-123');
    });

    it('should return empty categories when no annotations exist', async () => {
      const emptyAnnotations = {
        comments: [],
        highlights: [],
        tags: [],
        links: [],
        assessments: [],
      };
      mockViewStorage.getResourceAnnotations.mockResolvedValue(emptyAnnotations);

      const result = await AnnotationContext.getResourceAnnotations('test-123' as ResourceId, mockConfig);

      expect(result).toEqual(emptyAnnotations);
    });
  });

  describe('getAllAnnotations', () => {
    const mockAnnotations: Annotation[] = [
      mockAnnotation,
      {
        ...mockAnnotation,
        id: 'http://localhost:4000/annotations/anno-2',
        motivation: 'highlighting',
      },
    ];

    it('should return flat list of all annotations', async () => {
      mockViewStorage.getAllAnnotations.mockResolvedValue(mockAnnotations);

      const result = await AnnotationContext.getAllAnnotations('test-123' as ResourceId, mockConfig);

      expect(result).toEqual(mockAnnotations);
      expect(mockViewStorage.getAllAnnotations).toHaveBeenCalledWith('test-123');
    });

    it('should return empty array when no annotations exist', async () => {
      mockViewStorage.getAllAnnotations.mockResolvedValue([]);

      const result = await AnnotationContext.getAllAnnotations('test-123' as ResourceId, mockConfig);

      expect(result).toEqual([]);
    });
  });

  describe('getAnnotation', () => {
    it('should return specific annotation by ID', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(mockAnnotation);

      const result = await AnnotationContext.getAnnotation(
        'anno-1' as AnnotationId,
        'test-123' as ResourceId,
        mockConfig
      );

      expect(result).toEqual(mockAnnotation);
      expect(mockViewStorage.getAnnotation).toHaveBeenCalledWith('anno-1', 'test-123');
    });

    it('should return null when annotation not found', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(null);

      const result = await AnnotationContext.getAnnotation(
        'nonexistent' as AnnotationId,
        'test-123' as ResourceId,
        mockConfig
      );

      expect(result).toBeNull();
    });
  });

  describe('listAnnotations', () => {
    const mockAnnotations: Annotation[] = [mockAnnotation];

    it('should throw error when resourceId not provided', async () => {
      await expect(
        AnnotationContext.listAnnotations(undefined, mockConfig)
      ).rejects.toThrow('resourceId is required');
    });

    it('should filter by resource ID', async () => {
      const filters = { resourceId: 'test-123' as ResourceId };
      mockViewStorage.getAllAnnotations.mockResolvedValue(mockAnnotations);

      const result = await AnnotationContext.listAnnotations(filters, mockConfig);

      expect(result).toEqual(mockAnnotations);
    });

    it('should filter by annotation type', async () => {
      const filters = { resourceId: 'test-123' as ResourceId, type: 'commenting' as const };
      const resourceAnnotations = {
        comments: [mockAnnotation],
        highlights: [],
        tags: [],
        links: [],
        assessments: [],
      };
      mockViewStorage.getResourceAnnotations.mockResolvedValue(resourceAnnotations);

      const result = await AnnotationContext.listAnnotations(filters, mockConfig);

      expect(result).toEqual([mockAnnotation]);
    });
  });

  describe('resourceExists', () => {
    it('should return true when resource exists', async () => {
      mockViewStorage.resourceExists.mockResolvedValue(true);

      const result = await AnnotationContext.resourceExists('test-123' as ResourceId, mockConfig);

      expect(result).toBe(true);
      expect(mockViewStorage.resourceExists).toHaveBeenCalledWith('test-123');
    });

    it('should return false when resource does not exist', async () => {
      mockViewStorage.resourceExists.mockResolvedValue(false);

      const result = await AnnotationContext.resourceExists('nonexistent' as ResourceId, mockConfig);

      expect(result).toBe(false);
    });
  });

  describe('getResourceStats', () => {
    it('should return resource statistics', async () => {
      const mockStats = {
        resourceId: 'test-123' as ResourceId,
        version: 5,
        updatedAt: '2024-01-05T12:00:00Z',
      };
      mockViewStorage.getResourceStats.mockResolvedValue(mockStats);

      const result = await AnnotationContext.getResourceStats('test-123' as ResourceId, mockConfig);

      expect(result).toEqual(mockStats);
      expect(mockViewStorage.getResourceStats).toHaveBeenCalledWith('test-123');
    });

    it('should handle resources with no updates', async () => {
      const mockStats = {
        resourceId: 'test-123' as ResourceId,
        version: 0,
        updatedAt: '2024-01-01T00:00:00Z',
      };
      mockViewStorage.getResourceStats.mockResolvedValue(mockStats);

      const result = await AnnotationContext.getResourceStats('test-123' as ResourceId, mockConfig);

      expect(result.version).toBe(0);
    });
  });

  describe('getAnnotationContext', () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7';

    it('should return annotation with surrounding context', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(mockAnnotation);
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));

      const result = await AnnotationContext.getAnnotationContext(
        'anno-1' as AnnotationId,
        'test-123' as ResourceId,
        2, // contextBefore
        2, // contextAfter
        mockConfig
      );

      expect(result.annotation).toEqual(mockAnnotation);
      expect(result.contextBefore).toBeDefined();
      expect(result.contextAfter).toBeDefined();
    });

    it('should throw error when annotation not found', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(null);

      await expect(
        AnnotationContext.getAnnotationContext(
          'nonexistent' as AnnotationId,
          'test-123' as ResourceId,
          2,
          2,
          mockConfig
        )
      ).rejects.toThrow('Annotation not found');
    });

    it('should handle context at document boundaries', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue({
        ...mockAnnotation,
        target: {
          type: 'SpecificResource',
          source: 'http://localhost:4000/resources/test-123',
          selector: {
            type: 'TextPositionSelector',
            start: 0,
            end: 6, // "Line 1"
          },
        },
      });
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));

      const result = await AnnotationContext.getAnnotationContext(
        'anno-1' as AnnotationId,
        'test-123' as ResourceId,
        10, // More lines than available before
        2,
        mockConfig
      );

      expect(result.contextBefore).toBe('');
    });
  });

  describe('generateAnnotationSummary', () => {
    const content = 'This is test content with an annotation.';

    it('should generate AI summary for annotation', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(mockAnnotation);
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(generateText).mockResolvedValue('This annotation discusses the opening phrase of the document.');

      const result = await AnnotationContext.generateAnnotationSummary(
        'anno-1' as AnnotationId,
        'test-123' as ResourceId,
        mockConfig
      );

      expect(result.summary).toBe('This annotation discusses the opening phrase of the document.');
      expect(result.annotationId).toBe('anno-1');
      expect(generateText).toHaveBeenCalled();
    });

    it('should throw error when annotation not found', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(null);

      await expect(
        AnnotationContext.generateAnnotationSummary(
          'nonexistent' as AnnotationId,
          'test-123' as ResourceId,
          mockConfig
        )
      ).rejects.toThrow('Annotation not found');
    });

    it('should include annotation body in prompt', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(mockAnnotation);
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(generateText).mockResolvedValue('Summary text');

      await AnnotationContext.generateAnnotationSummary(
        'anno-1' as AnnotationId,
        'test-123' as ResourceId,
        mockConfig
      );

      const promptCall = vi.mocked(generateText).mock.calls[0];
      expect(promptCall?.[0]).toContain('This is a comment');
    });
  });

  describe('buildLLMContext', () => {
    const annotationUri = 'http://localhost:4000/annotations/anno-1';
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';

    it('should build comprehensive LLM context', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(mockAnnotation);
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));

      const result = await AnnotationContext.buildLLMContext(
        annotationUri,
        'test-123' as ResourceId,
        mockConfig,
        { contextLines: 2 }
      );

      expect(result.annotation).toEqual(mockAnnotation);
      expect(result.resourceMetadata).toEqual(mockResource);
      expect(result.surroundingText).toBeDefined();
    });

    it('should respect contextLines option', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(mockAnnotation);
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));

      const result = await AnnotationContext.buildLLMContext(
        annotationUri,
        'test-123' as ResourceId,
        mockConfig,
        { contextLines: 10 }
      );

      expect(result.surroundingText).toBeDefined();
    });

    it('should exclude metadata when requested', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(mockAnnotation);
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));

      const result = await AnnotationContext.buildLLMContext(
        annotationUri,
        'test-123' as ResourceId,
        mockConfig,
        { includeMetadata: false }
      );

      expect(result.resourceMetadata).toBeUndefined();
    });

    it('should throw error when annotation not found', async () => {
      mockViewStorage.getAnnotation.mockResolvedValue(null);

      await expect(
        AnnotationContext.buildLLMContext(
          annotationUri,
          'test-123' as ResourceId,
          mockConfig,
          {}
        )
      ).rejects.toThrow();
    });
  });
});
