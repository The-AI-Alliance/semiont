import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceContext } from '../src/resource-context';
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

import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';

describe('ResourceContext', () => {
  let mockConfig: EnvironmentConfig;
  let mockViewStorage: any;
  let mockRepStore: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        filesystem: { path: '/test/data' },
        backend: { publicURL: 'http://localhost:4000' },
      },
      storage: {
        base: '/test/storage',
      },
      _metadata: { projectRoot: '/test' },
    } as EnvironmentConfig;

    mockViewStorage = {
      getResourceMetadata: vi.fn(),
      listResources: vi.fn(),
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

    it('should return resource metadata when found', async () => {
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);

      const result = await ResourceContext.getResourceMetadata('test-123' as ResourceId, mockConfig);

      expect(result).toEqual(mockResource);
      expect(mockViewStorage.getResourceMetadata).toHaveBeenCalledWith('test-123');
    });

    it('should return null when resource not found', async () => {
      mockViewStorage.getResourceMetadata.mockResolvedValue(null);

      const result = await ResourceContext.getResourceMetadata('nonexistent' as ResourceId, mockConfig);

      expect(result).toBeNull();
    });

    it('should initialize FilesystemViewStorage with correct config', async () => {
      mockViewStorage.getResourceMetadata.mockResolvedValue(mockResource);

      await ResourceContext.getResourceMetadata('test-123' as ResourceId, mockConfig);

      expect(FilesystemViewStorage).toHaveBeenCalledWith(mockConfig);
    });
  });

  describe('listResources', () => {
    const mockResources: ResourceDescriptor[] = [
      {
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/res-1',
        name: 'Resource 1',
        archived: false,
        entityTypes: ['Document'],
        creationMethod: 'api',
        dateCreated: '2024-01-01T00:00:00Z',
        representations: [],
      },
      {
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/res-2',
        name: 'Resource 2',
        archived: false,
        entityTypes: ['Image'],
        creationMethod: 'upload',
        dateCreated: '2024-01-02T00:00:00Z',
        representations: [],
      },
    ];

    it('should list all resources when no filters provided', async () => {
      mockViewStorage.listResources.mockResolvedValue(mockResources);

      const result = await ResourceContext.listResources(undefined, mockConfig);

      expect(result).toEqual(mockResources);
      expect(mockViewStorage.listResources).toHaveBeenCalledWith(undefined);
    });

    it('should apply filters when provided', async () => {
      const filters = {
        createdAfter: '2024-01-01T00:00:00Z',
        mimeType: 'text/plain',
        limit: 10,
      };

      mockViewStorage.listResources.mockResolvedValue([mockResources[0]]);

      const result = await ResourceContext.listResources(filters, mockConfig);

      expect(result).toEqual([mockResources[0]]);
      expect(mockViewStorage.listResources).toHaveBeenCalledWith(filters);
    });

    it('should return empty array when no resources found', async () => {
      mockViewStorage.listResources.mockResolvedValue([]);

      const result = await ResourceContext.listResources(undefined, mockConfig);

      expect(result).toEqual([]);
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

    it('should add content previews to resources', async () => {
      const content = 'This is test content';
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(content));

      const result = await ResourceContext.addContentPreviews([mockResource], mockConfig);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ...mockResource,
        content,
      });
      expect(mockRepStore.retrieve).toHaveBeenCalledWith('abc123', 'text/plain');
    });

    it('should handle multiple resources', async () => {
      const resources = [
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

      mockRepStore.retrieve
        .mockResolvedValueOnce(Buffer.from('Content 1'))
        .mockResolvedValueOnce(Buffer.from('Content 2'));

      const result = await ResourceContext.addContentPreviews(resources, mockConfig);

      expect(result).toHaveLength(2);
      expect(result[0]!.content).toBe('Content 1');
      expect(result[1]!.content).toBe('Content 2');
    });

    it('should skip resources without representations', async () => {
      const resourceWithoutReps = {
        ...mockResource,
        representations: [],
      };

      const result = await ResourceContext.addContentPreviews([resourceWithoutReps], mockConfig);

      expect(result).toHaveLength(0);
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    it('should skip resources on retrieval error', async () => {
      mockRepStore.retrieve.mockRejectedValue(new Error('Content not found'));

      const result = await ResourceContext.addContentPreviews([mockResource], mockConfig);

      expect(result).toHaveLength(0);
    });

    it('should handle empty input array', async () => {
      const result = await ResourceContext.addContentPreviews([], mockConfig);

      expect(result).toEqual([]);
      expect(mockRepStore.retrieve).not.toHaveBeenCalled();
    });

    it('should truncate content to preview length', async () => {
      const longContent = 'a'.repeat(10000);
      mockRepStore.retrieve.mockResolvedValue(Buffer.from(longContent));

      const result = await ResourceContext.addContentPreviews([mockResource], mockConfig);

      expect(result[0]!.content.length).toBeLessThanOrEqual(5000);
    });
  });
});
