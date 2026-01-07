/**
 * Unit tests for ResourceContext
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ResourceContext } from '../resource-context';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Mock dependencies
vi.mock('@semiont/event-sourcing', () => ({
  FilesystemViewStorage: vi.fn(),
}));

vi.mock('@semiont/content', () => ({
  FilesystemRepresentationStore: vi.fn(),
}));

vi.mock('@semiont/api-client', () => ({
  getPrimaryRepresentation: vi.fn(),
  decodeRepresentation: vi.fn(),
}));

import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { getPrimaryRepresentation, decodeRepresentation } from '@semiont/api-client';

describe('ResourceContext', () => {
  let mockConfig: EnvironmentConfig;
  let mockViewStorage: any;
  let mockRepStore: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        filesystem: { path: '/test/data' },
        backend: {
          publicURL: 'http://localhost:4000',
          platform: 'local',
          port: 4000,
          corsOrigin: '*',
        },
      },
      storage: {
        base: '/test/storage',
      },
      _metadata: {
        environment: 'test',
        projectRoot: '/test',
      },
    } as unknown as EnvironmentConfig;

    mockViewStorage = {
      get: vi.fn(),
      getAll: vi.fn(),
    };

    mockRepStore = {
      retrieve: vi.fn(),
    };

    vi.mocked(FilesystemViewStorage).mockImplementation(() => mockViewStorage);
    vi.mocked(FilesystemRepresentationStore).mockImplementation(() => mockRepStore);
  });

  describe('getResourceMetadata', () => {
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

      const result = await ResourceContext.getResourceMetadata('test-123' as ResourceId, mockConfig);

      expect(result).toEqual(mockResource);
      expect(mockViewStorage.get).toHaveBeenCalledWith('test-123');
    });

    test('should return null when resource not found', async () => {
      mockViewStorage.get.mockResolvedValue(null);

      const result = await ResourceContext.getResourceMetadata('nonexistent' as ResourceId, mockConfig);

      expect(result).toBeNull();
      expect(mockViewStorage.get).toHaveBeenCalledWith('nonexistent');
    });

    test('should initialize FilesystemViewStorage with correct config', async () => {
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

      await ResourceContext.getResourceMetadata('test-123' as ResourceId, mockConfig);

      expect(FilesystemViewStorage).toHaveBeenCalledWith('/test/data', '/test');
    });
  });

  describe('listResources', () => {
    const mockResource1: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': 'http://localhost:4000/resources/res-1',
      name: 'Resource 1',
      archived: false,
      entityTypes: ['Document'],
      creationMethod: 'api',
      dateCreated: '2024-01-01T00:00:00Z',
      representations: [],
    };

    const mockResource2: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': 'http://localhost:4000/resources/res-2',
      name: 'Resource 2',
      archived: false,
      entityTypes: ['Image'],
      creationMethod: 'upload',
      dateCreated: '2024-01-02T00:00:00Z',
      representations: [],
    };

    const mockResource3: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': 'http://localhost:4000/resources/res-3',
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

      const result = await ResourceContext.listResources(undefined, mockConfig);

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

      const result = await ResourceContext.listResources({ archived: false }, mockConfig);

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

      const result = await ResourceContext.listResources({ archived: true }, mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockResource3);
      expect(result.every(r => r.archived)).toBe(true);
    });

    test('should filter by search term (case insensitive)', async () => {
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
          resource: { ...mockResource2, name: 'Special Document' },
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

      const result = await ResourceContext.listResources({ search: 'special' }, mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('Special Document');
    });

    test('should filter by search term (partial match)', async () => {
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

      const result = await ResourceContext.listResources({ search: 'resource' }, mockConfig);

      expect(result).toHaveLength(2);
    });

    test('should combine archived and search filters', async () => {
      const searchableArchived: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/res-4',
        name: 'Archived Special',
        archived: true,
        entityTypes: ['Document'],
        creationMethod: 'api',
        dateCreated: '2024-01-04T00:00:00Z',
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
          resource: searchableArchived,
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

      const result = await ResourceContext.listResources(
        { archived: true, search: 'special' },
        mockConfig
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(searchableArchived);
    });

    test('should return empty array when no matches', async () => {
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
      ]);

      const result = await ResourceContext.listResources({ search: 'nonexistent' }, mockConfig);

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

      const result = await ResourceContext.listResources(undefined, mockConfig);

      // Should be sorted newest first
      expect(result[0]?.dateCreated).toBe('2024-01-03T00:00:00Z');
      expect(result[1]?.dateCreated).toBe('2024-01-02T00:00:00Z');
      expect(result[2]?.dateCreated).toBe('2024-01-01T00:00:00Z');
    });

    test('should handle resources without dateCreated', async () => {
      const resourceNoDate: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/res-no-date',
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

      const result = await ResourceContext.listResources(undefined, mockConfig);

      expect(result).toHaveLength(2);
      // Resource with date should come first
      expect(result[0]).toEqual(mockResource1);
    });
  });

  describe('addContentPreviews', () => {
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

      const result = await ResourceContext.addContentPreviews([mockResource], mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ...mockResource,
        content,
      });
      expect(mockRepStore.retrieve).toHaveBeenCalledWith('abc123', 'text/plain');
      expect(decodeRepresentation).toHaveBeenCalledWith(Buffer.from(content), 'text/plain');
    });

    test('should handle multiple resources', async () => {
      const resources: ResourceDescriptor[] = [
        mockResource,
        {
          ...mockResource,
          '@id': 'http://localhost:4000/resources/test-456',
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

      vi.mocked(getPrimaryRepresentation).mockImplementation((resource) => {
        const reps = resource?.representations;
        return Array.isArray(reps) ? reps[0] : reps;
      });

      mockRepStore.retrieve
        .mockResolvedValueOnce(Buffer.from('Content 1'))
        .mockResolvedValueOnce(Buffer.from('Content 2'));

      vi.mocked(decodeRepresentation)
        .mockReturnValueOnce('Content 1')
        .mockReturnValueOnce('Content 2');

      const result = await ResourceContext.addContentPreviews(resources, mockConfig);

      expect(result).toHaveLength(2);
      expect(result[0]?.content).toBe('Content 1');
      expect(result[1]?.content).toBe('Content 2');
    });

    test('should handle resources without representations', async () => {
      const resourceWithoutReps: ResourceDescriptor = {
        ...mockResource,
        representations: [],
      };

      vi.mocked(getPrimaryRepresentation).mockReturnValue(undefined);

      const result = await ResourceContext.addContentPreviews([resourceWithoutReps], mockConfig);

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
        representations: [repWithoutChecksum],
      };

      vi.mocked(getPrimaryRepresentation).mockReturnValue(repWithoutChecksum);

      const result = await ResourceContext.addContentPreviews([resourceNoChecksum], mockConfig);

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

      const result = await ResourceContext.addContentPreviews([mockResource], mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ ...mockResource, content: '' });
    });

    test('should handle empty input array', async () => {
      const result = await ResourceContext.addContentPreviews([], mockConfig);

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

      const result = await ResourceContext.addContentPreviews([mockResource], mockConfig);

      expect(result[0]?.content).toHaveLength(200);
      expect(result[0]?.content).toBe(longContent.slice(0, 200));
    });

    test('should initialize FilesystemRepresentationStore with correct config', async () => {
      vi.mocked(getPrimaryRepresentation).mockReturnValue({
        mediaType: 'text/plain',
        checksum: 'abc123',
        byteSize: 100,
        rel: 'original',
      });

      mockRepStore.retrieve.mockResolvedValue(Buffer.from('test'));
      vi.mocked(decodeRepresentation).mockReturnValue('test');

      await ResourceContext.addContentPreviews([mockResource], mockConfig);

      expect(FilesystemRepresentationStore).toHaveBeenCalledWith(
        { basePath: '/test/data' },
        '/test'
      );
    });
  });
});
