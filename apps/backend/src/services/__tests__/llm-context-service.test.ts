import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMContextService, type LLMContextOptions } from '../llm-context-service';
import type { EnvironmentConfig } from '@semiont/core';
import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

// Mock dependencies
vi.mock('@semiont/graph', () => ({
  getGraphDatabase: vi.fn(),
}));

vi.mock('@semiont/inference', () => ({
  generateResourceSummary: vi.fn(),
  generateReferenceSuggestions: vi.fn(),
}));

vi.mock('@semiont/content', () => ({
  FilesystemRepresentationStore: vi.fn(),
}));

import { getGraphDatabase } from '@semiont/graph';
import { generateResourceSummary, generateReferenceSuggestions } from '@semiont/make-meaning';
import { FilesystemRepresentationStore } from '@semiont/content';

describe('LLMContextService', () => {
  let mockConfig: EnvironmentConfig;
  let mockGraphDb: any;
  let mockRepStore: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        filesystem: { path: '/test/data' },
        backend: { publicURL: 'http://localhost:4000' },
      },
      _metadata: { projectRoot: '/test' },
    } as EnvironmentConfig;

    // Mock graph database
    mockGraphDb = {
      getResource: vi.fn(),
      getResourceConnections: vi.fn(),
      listAnnotations: vi.fn(),
    };

    // Mock representation store
    mockRepStore = {
      retrieve: vi.fn(),
    };

    vi.mocked(getGraphDatabase).mockResolvedValue(mockGraphDb);
    vi.mocked(FilesystemRepresentationStore).mockImplementation(() => mockRepStore);
  });

  describe('getResourceLLMContext', () => {
    const mockMainResource: ResourceDescriptor = {
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

    const mockRelatedResource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': 'http://localhost:4000/resources/related-456',
      name: 'Related Resource',
      archived: false,
      entityTypes: ['Reference'],
      creationMethod: 'api',
      dateCreated: '2024-01-02T00:00:00Z',
      representations: [
        {
          mediaType: 'text/plain',
          checksum: 'def456',
          byteSize: 50,
          rel: 'original',
        },
      ],
    };

    const mockAnnotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: 'http://localhost:4000/annotations/anno-1',
      motivation: 'tagging',
      target: {
        source: 'http://localhost:4000/resources/test-123',
        selector: {
          type: 'TextPositionSelector',
          start: 0,
          end: 10,
        },
      },
      body: [{ type: 'TextualBody', value: 'test tag' }],
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
    };

    it('should return basic context without content', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue([
        { targetResource: mockRelatedResource, relationshipType: 'references' },
      ]);
      mockGraphDb.listAnnotations.mockResolvedValue({
        annotations: [mockAnnotation],
        total: 1,
      });

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: false,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.mainResource).toEqual(mockMainResource);
      expect(result.relatedResources).toHaveLength(1);
      expect(result.relatedResources[0]).toEqual(mockRelatedResource);
      expect(result.annotations).toHaveLength(1);
      expect(result.graph.nodes).toHaveLength(2);
      expect(result.graph.edges).toHaveLength(1);
      expect(result.mainResourceContent).toBeUndefined();
      expect(result.summary).toBeUndefined();
    });

    it('should include content when requested', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue([]);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });
      mockRepStore.retrieve.mockResolvedValue(Buffer.from('Test content'));

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: true,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.mainResourceContent).toBe('Test content');
      expect(mockRepStore.retrieve).toHaveBeenCalledWith('abc123', 'text/plain');
    });

    it('should include summary when requested', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue([]);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });
      mockRepStore.retrieve.mockResolvedValue(Buffer.from('Test content'));
      vi.mocked(generateResourceSummary).mockResolvedValue('Generated summary');

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: true,
        includeSummary: true,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.summary).toBe('Generated summary');
      expect(generateResourceSummary).toHaveBeenCalledWith(
        'Test Resource',
        'Test content',
        ['Document'],
        mockConfig
      );
    });

    it('should include reference suggestions when content is available', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue([]);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });
      mockRepStore.retrieve.mockResolvedValue(Buffer.from('Test content'));
      vi.mocked(generateReferenceSuggestions).mockResolvedValue(['Ref 1', 'Ref 2']);

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: true,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.suggestedReferences).toEqual(['Ref 1', 'Ref 2']);
      expect(generateReferenceSuggestions).toHaveBeenCalledWith('Test content', mockConfig);
    });

    it('should limit related resources based on maxResources', async () => {
      // Arrange
      const manyRelatedResources = Array.from({ length: 20 }, (_, i) => ({
        targetResource: {
          ...mockRelatedResource,
          '@id': `http://localhost:4000/resources/related-${i}`,
          name: `Related ${i}`,
        },
        relationshipType: 'references',
      }));

      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue(manyRelatedResources);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 5,
        includeContent: false,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      // maxResources - 1 because main resource counts as one
      expect(result.relatedResources).toHaveLength(4);
    });

    it('should throw error when resource not found', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(null);

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: false,
        includeSummary: false,
      };

      // Act & Assert
      await expect(
        LLMContextService.getResourceLLMContext('nonexistent', options, mockConfig)
      ).rejects.toThrow('Resource not found');
    });

    it('should handle missing content gracefully', async () => {
      // Arrange
      const resourceWithoutContent = {
        ...mockMainResource,
        representations: [],
      };

      mockGraphDb.getResource.mockResolvedValue(resourceWithoutContent);
      mockGraphDb.getResourceConnections.mockResolvedValue([]);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: true,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.mainResourceContent).toBeUndefined();
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    it('should build graph with correct nodes and edges', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue([
        { targetResource: mockRelatedResource, relationshipType: 'cites' },
      ]);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: false,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.graph.nodes).toEqual([
        {
          id: 'test-123',
          type: 'resource',
          label: 'Test Resource',
          metadata: { entityTypes: ['Document'] },
        },
        {
          id: 'related-456',
          type: 'resource',
          label: 'Related Resource',
          metadata: { entityTypes: ['Reference'] },
        },
      ]);

      expect(result.graph.edges).toEqual([
        {
          source: 'test-123',
          target: 'related-456',
          type: 'cites',
          metadata: {},
        },
      ]);
    });

    it('should include related resource content when requested', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue([
        { targetResource: mockRelatedResource, relationshipType: 'references' },
      ]);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });

      mockRepStore.retrieve
        .mockResolvedValueOnce(Buffer.from('Main content'))
        .mockResolvedValueOnce(Buffer.from('Related content'));

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: true,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.mainResourceContent).toBe('Main content');
      expect(result.relatedResourcesContent).toEqual({
        'related-456': 'Related content',
      });
    });

    it('should skip related resource content on retrieval error', async () => {
      // Arrange
      mockGraphDb.getResource.mockResolvedValue(mockMainResource);
      mockGraphDb.getResourceConnections.mockResolvedValue([
        { targetResource: mockRelatedResource, relationshipType: 'references' },
      ]);
      mockGraphDb.listAnnotations.mockResolvedValue({ annotations: [], total: 0 });

      mockRepStore.retrieve
        .mockResolvedValueOnce(Buffer.from('Main content'))
        .mockRejectedValueOnce(new Error('Content not found'));

      const options: LLMContextOptions = {
        depth: 1,
        maxResources: 10,
        includeContent: true,
        includeSummary: false,
      };

      // Act
      const result = await LLMContextService.getResourceLLMContext('test-123', options, mockConfig);

      // Assert
      expect(result.mainResourceContent).toBe('Main content');
      expect(result.relatedResourcesContent).toEqual({});
    });
  });
});
