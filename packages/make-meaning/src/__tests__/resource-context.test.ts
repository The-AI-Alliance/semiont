/**
 * Unit tests for ResourceContext
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ResourceContext } from '../resource-context';
import type { ResourceDescriptor, ResourceId } from '@semiont/core';
import { resourceId } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';

// Mock the helpers ResourceContext reads from core. Use importOriginal so
// branded constructors (resourceId, etc.) keep their real implementations.
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
    getPrimaryRepresentation: vi.fn(),
    decodeRepresentation: vi.fn(),
  };
});

import { getPrimaryRepresentation, decodeRepresentation } from '@semiont/core';
describe('ResourceContext', () => {
  let mockKb: KnowledgeBase;
  let mockViewStorage: any;
  let mockRepStore: any;
  let mockGraph: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockViewStorage = {
      get: vi.fn(),
      getAll: vi.fn(),
    };

    mockRepStore = {
      retrieve: vi.fn(),
    };

    mockGraph = {
      searchResources: vi.fn().mockResolvedValue([]),
    };

    mockKb = {
      eventStore: {} as any,
      views: mockViewStorage,
      content: mockRepStore,
      graph: mockGraph,
      projectionsDir: '',
      graphConsumer: {} as any,
    };
  });

  describe('getResourceMetadata', () => {
    const mockResource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('test-123'),
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

    test('should return resource metadata when found', async () => {
      mockViewStorage.get.mockResolvedValue({
        resource: mockResource,
        annotations: {
          highlights: [],
          assessments: [],
          comments: [],
          tags: [],
          links: [],
          entityReferences: [],
        },
      });

      const result = await ResourceContext.getResourceMetadata('test-123' as ResourceId, mockKb);

      expect(result).toEqual(mockResource);
      expect(mockViewStorage.get).toHaveBeenCalledWith('test-123');
    });

    test('should return null when resource not found', async () => {
      mockViewStorage.get.mockResolvedValue(null);

      const result = await ResourceContext.getResourceMetadata('nonexistent' as ResourceId, mockKb);

      expect(result).toBeNull();
      expect(mockViewStorage.get).toHaveBeenCalledWith('nonexistent');
    });

  });

  describe('listResources', () => {
    const mockResource1: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('res-1'),
      name: 'Resource 1',
      archived: false,
      entityTypes: ['Document'],
      creationMethod: 'api',
      dateCreated: '2024-01-01T00:00:00Z',
      representations: [],
    };

    const mockResource2: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('res-2'),
      name: 'Resource 2',
      archived: false,
      entityTypes: ['Image'],
      creationMethod: 'upload',
      dateCreated: '2024-01-02T00:00:00Z',
      representations: [],
    };

    const mockResource3: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('res-3'),
      name: 'Archived Resource',
      archived: true,
      entityTypes: ['Document'],
      creationMethod: 'api',
      dateCreated: '2024-01-03T00:00:00Z',
      representations: [],
    };

    test('should list all resources when no filters provided', async () => {
      mockViewStorage.getAll.mockResolvedValue([
        {
          resource: mockResource1,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
        {
          resource: mockResource2,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
      ]);

      const result = await ResourceContext.listResources(undefined, mockKb);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(mockResource1);
      expect(result).toContainEqual(mockResource2);
    });

    test('should filter by archived status (false)', async () => {
      mockViewStorage.getAll.mockResolvedValue([
        {
          resource: mockResource1,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
        {
          resource: mockResource3,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
      ]);

      const result = await ResourceContext.listResources({ archived: false }, mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockResource1);
      expect(result.every(r => !r.archived)).toBe(true);
    });

    test('should filter by archived status (true)', async () => {
      mockViewStorage.getAll.mockResolvedValue([
        {
          resource: mockResource1,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
        {
          resource: mockResource3,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
      ]);

      const result = await ResourceContext.listResources({ archived: true }, mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockResource3);
      expect(result.every(r => r.archived)).toBe(true);
    });

    test('should delegate to graph.searchResources when search is set', async () => {
      const specialDoc = { ...mockResource2, name: 'Special Document' };
      mockGraph.searchResources.mockResolvedValue([specialDoc]);

      const result = await ResourceContext.listResources({ search: 'special' }, mockKb);

      expect(mockGraph.searchResources).toHaveBeenCalledWith('special');
      expect(mockViewStorage.getAll).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('Special Document');
    });

    test('should narrow graph search results by archived filter', async () => {
      const searchableArchived: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': resourceId('res-4'),
        name: 'Archived Special',
        archived: true,
        entityTypes: ['Document'],
        creationMethod: 'api',
        dateCreated: '2024-01-04T00:00:00Z',
        representations: [],
      };

      mockGraph.searchResources.mockResolvedValue([
        { ...mockResource1, name: 'Special Live' },
        searchableArchived,
      ]);

      const result = await ResourceContext.listResources(
        { archived: true, search: 'special' },
        mockKb
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(searchableArchived);
    });

    test('should return empty array when graph search has no matches', async () => {
      mockGraph.searchResources.mockResolvedValue([]);

      const result = await ResourceContext.listResources({ search: 'nonexistent' }, mockKb);

      expect(result).toEqual([]);
    });

    test('should sort by creation date (newest first)', async () => {
      mockViewStorage.getAll.mockResolvedValue([
        {
          resource: mockResource1,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
        {
          resource: mockResource2,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
        {
          resource: mockResource3,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
      ]);

      const result = await ResourceContext.listResources(undefined, mockKb);

      // Should be sorted newest first
      expect(result[0]?.dateCreated).toBe('2024-01-03T00:00:00Z');
      expect(result[1]?.dateCreated).toBe('2024-01-02T00:00:00Z');
      expect(result[2]?.dateCreated).toBe('2024-01-01T00:00:00Z');
    });

    test('should handle resources without dateCreated', async () => {
      const resourceNoDate: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': resourceId('res-no-date'),
        name: 'No Date Resource',
        archived: false,
        entityTypes: ['Document'],
        creationMethod: 'api',
        representations: [],
      };

      mockViewStorage.getAll.mockResolvedValue([
        {
          resource: mockResource1,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
        {
          resource: resourceNoDate,
          annotations: {
            highlights: [],
            assessments: [],
            comments: [],
            tags: [],
            links: [],
            entityReferences: [],
          },
        },
      ]);

      const result = await ResourceContext.listResources(undefined, mockKb);

      expect(result).toHaveLength(2);
      // Resource with date should come first
      expect(result[0]).toEqual(mockResource1);
    });
  });

  describe('addContentPreviews', () => {
    const mockResource: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': resourceId('test-123'),
      name: 'Test Resource',
      archived: false,
      entityTypes: ['Document'],
      creationMethod: 'api',
      dateCreated: '2024-01-01T00:00:00Z',
      storageUri: 'abc123',
      representations: [
        {
          mediaType: 'text/plain',
          checksum: 'abc123',
          byteSize: 100,
          rel: 'original',
        },
      ],
    };

    test('should add content previews to resources', async () => {
      const content = 'This is test content';

      vi.mocked(getPrimaryRepresentation).mockReturnValue({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 100,
        rel: 'original',
      });

      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));
      vi.mocked(decodeRepresentation).mockReturnValue(content);

      const result = await ResourceContext.addContentPreviews([mockResource], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ...mockResource,
        content,
      });
      expect(mockRepStore.retrieve).toHaveBeenCalledWith('abc123');
      expect(decodeRepresentation).toHaveBeenCalledWith(Buffer.from(content), 'text/plain');
    });

    test('should handle multiple resources', async () => {
      const resources: ResourceDescriptor[] = [
        mockResource,
        {
          ...mockResource,
          '@id': resourceId('test-456'),
          representations: [
            {
              mediaType: 'text/plain',
              checksum: 'def456',
              byteSize: 50,
              rel: 'original',
            },
          ],
        },
      ];

      vi.mocked(getPrimaryRepresentation).mockImplementation((resource: Parameters<typeof getPrimaryRepresentation>[0]) => {
        const reps = resource?.representations;
        return Array.isArray(reps) ? reps[0] : reps;
      });

      mockRepStore.retrieve
        .mockResolvedValueOnce(Buffer.from('Content 1'))
        .mockResolvedValueOnce(Buffer.from('Content 2'));

      vi.mocked(decodeRepresentation)
        .mockReturnValueOnce('Content 1')
        .mockReturnValueOnce('Content 2');

      const result = await ResourceContext.addContentPreviews(resources, mockKb);

      expect(result).toHaveLength(2);
      expect(result[0]?.content).toBe('Content 1');
      expect(result[1]?.content).toBe('Content 2');
    });

    test('should handle resources without representations', async () => {
      const resourceWithoutReps: ResourceDescriptor = {
        ...mockResource,
        storageUri: undefined,
        representations: [],
      };

      vi.mocked(getPrimaryRepresentation).mockReturnValue(undefined);

      const result = await ResourceContext.addContentPreviews([resourceWithoutReps], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ...resourceWithoutReps, content: '' });
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    test('should handle resources without checksum', async () => {
      const repWithoutChecksum = {
        mediaType: 'text/plain',
        byteSize: 100,
        rel: 'original' as const,
      };

      const resourceNoChecksum: ResourceDescriptor = {
        ...mockResource,
        storageUri: undefined,
        representations: [repWithoutChecksum],
      };

      vi.mocked(getPrimaryRepresentation).mockReturnValue(repWithoutChecksum);

      const result = await ResourceContext.addContentPreviews([resourceNoChecksum], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe('');
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    test('should handle retrieval errors gracefully', async () => {
      vi.mocked(getPrimaryRepresentation).mockReturnValue({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 100,
        rel: 'original',
      });

      mockRepStore.retrieve.mockRejectedValue(new Error('Content not found'));

      const result = await ResourceContext.addContentPreviews([mockResource], mockKb);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ...mockResource, content: '' });
    });

    test('should handle empty input array', async () => {
      const result = await ResourceContext.addContentPreviews([], mockKb);

      expect(result).toEqual([]);
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    test('should truncate content to 200 characters', async () => {
      const longContent = 'a'.repeat(500);

      vi.mocked(getPrimaryRepresentation).mockReturnValue({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 500,
        rel: 'original',
      });

      mockRepStore.retrieve.mockResolvedValue(Buffer.from(longContent));
      vi.mocked(decodeRepresentation).mockReturnValue(longContent);

      const result = await ResourceContext.addContentPreviews([mockResource], mockKb);

      expect(result[0]?.content).toHaveLength(200);
      expect(result[0]?.content).toBe(longContent.slice(0, 200));
    });

  });
});
