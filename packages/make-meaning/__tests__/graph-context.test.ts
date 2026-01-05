import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphContext } from '../src/graph-context';
import type { EnvironmentConfig, ResourceId, GraphPath } from '@semiont/core';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Mock dependencies
vi.mock('@semiont/graph', () => ({
  getGraphDatabase: vi.fn(),
}));

import { getGraphDatabase } from '@semiont/graph';

describe('GraphContext', () => {
  let mockConfig: EnvironmentConfig;
  let mockGraphDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      services: {
        backend: { publicURL: 'http://localhost:4000' },
      },
      _metadata: { projectRoot: '/test' },
    } as EnvironmentConfig;

    mockGraphDb = {
      getResourceReferencedBy: vi.fn(),
      findPath: vi.fn(),
      getResourceConnections: vi.fn(),
      searchResources: vi.fn(),
    };

    vi.mocked(getGraphDatabase).mockResolvedValue(mockGraphDb);
  });

  describe('getBacklinks', () => {
    const mockAnnotations: Annotation[] = [
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: 'http://localhost:4000/annotations/anno-1',
        motivation: 'linking',
        target: {
          source: 'http://localhost:4000/resources/target-123',
        },
        body: {
          type: 'SpecificResource',
          source: 'http://localhost:4000/resources/source-456',
        },
        created: '2024-01-01T00:00:00Z',
        modified: '2024-01-01T00:00:00Z',
      },
    ];

    it('should return backlinks for a resource', async () => {
      mockGraphDb.getResourceReferencedBy.mockResolvedValue(mockAnnotations);

      const result = await GraphContext.getBacklinks('test-123' as ResourceId, mockConfig);

      expect(result).toEqual(mockAnnotations);
      expect(mockGraphDb.getResourceReferencedBy).toHaveBeenCalledWith(
        'http://localhost:4000/resources/test-123'
      );
    });

    it('should return empty array when no backlinks found', async () => {
      mockGraphDb.getResourceReferencedBy.mockResolvedValue([]);

      const result = await GraphContext.getBacklinks('test-123' as ResourceId, mockConfig);

      expect(result).toEqual([]);
    });

    it('should use correct resource URI format', async () => {
      mockGraphDb.getResourceReferencedBy.mockResolvedValue([]);

      await GraphContext.getBacklinks('my-resource' as ResourceId, mockConfig);

      expect(mockGraphDb.getResourceReferencedBy).toHaveBeenCalledWith(
        'http://localhost:4000/resources/my-resource'
      );
    });
  });

  describe('findPath', () => {
    const mockPaths: GraphPath[] = [
      {
        nodes: ['res-1', 'res-2', 'res-3'],
        edges: [
          { from: 'res-1' as ResourceId, to: 'res-2' as ResourceId },
          { from: 'res-2' as ResourceId, to: 'res-3' as ResourceId },
        ],
        length: 2,
      },
    ];

    it('should find paths between resources', async () => {
      mockGraphDb.findPath.mockResolvedValue(mockPaths);

      const result = await GraphContext.findPath(
        'from-123' as ResourceId,
        'to-456' as ResourceId,
        mockConfig
      );

      expect(result).toEqual(mockPaths);
      expect(mockGraphDb.findPath).toHaveBeenCalledWith('from-123', 'to-456', undefined);
    });

    it('should respect maxDepth parameter', async () => {
      mockGraphDb.findPath.mockResolvedValue(mockPaths);

      const result = await GraphContext.findPath(
        'from-123' as ResourceId,
        'to-456' as ResourceId,
        mockConfig,
        3
      );

      expect(result).toEqual(mockPaths);
      expect(mockGraphDb.findPath).toHaveBeenCalledWith('from-123', 'to-456', 3);
    });

    it('should return empty array when no path found', async () => {
      mockGraphDb.findPath.mockResolvedValue([]);

      const result = await GraphContext.findPath(
        'from-123' as ResourceId,
        'to-456' as ResourceId,
        mockConfig
      );

      expect(result).toEqual([]);
    });
  });

  describe('getResourceConnections', () => {
    const mockConnections = [
      {
        from: 'res-1' as ResourceId,
        to: 'res-2' as ResourceId,
        via: 'anno-1',
        type: 'references',
      },
      {
        from: 'res-1' as ResourceId,
        to: 'res-3' as ResourceId,
        via: 'anno-2',
        type: 'cites',
      },
    ];

    it('should return resource connections', async () => {
      mockGraphDb.getResourceConnections.mockResolvedValue(mockConnections);

      const result = await GraphContext.getResourceConnections('res-1' as ResourceId, mockConfig);

      expect(result).toEqual(mockConnections);
      expect(mockGraphDb.getResourceConnections).toHaveBeenCalledWith('res-1');
    });

    it('should return empty array when no connections found', async () => {
      mockGraphDb.getResourceConnections.mockResolvedValue([]);

      const result = await GraphContext.getResourceConnections('isolated' as ResourceId, mockConfig);

      expect(result).toEqual([]);
    });
  });

  describe('searchResources', () => {
    const mockResults: ResourceDescriptor[] = [
      {
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/res-1',
        name: 'Neural Networks Paper',
        archived: false,
        entityTypes: ['Document'],
        creationMethod: 'api',
        dateCreated: '2024-01-01T00:00:00Z',
        representations: [],
      },
      {
        '@context': 'https://schema.org/',
        '@id': 'http://localhost:4000/resources/res-2',
        name: 'Deep Learning Tutorial',
        archived: false,
        entityTypes: ['Document'],
        creationMethod: 'api',
        dateCreated: '2024-01-02T00:00:00Z',
        representations: [],
      },
    ];

    it('should search resources by query', async () => {
      mockGraphDb.searchResources.mockResolvedValue(mockResults);

      const result = await GraphContext.searchResources('neural networks', mockConfig);

      expect(result).toEqual(mockResults);
      expect(mockGraphDb.searchResources).toHaveBeenCalledWith('neural networks', undefined);
    });

    it('should respect limit parameter', async () => {
      mockGraphDb.searchResources.mockResolvedValue([mockResults[0]]);

      const result = await GraphContext.searchResources('neural networks', mockConfig, 1);

      expect(result).toEqual([mockResults[0]]);
      expect(mockGraphDb.searchResources).toHaveBeenCalledWith('neural networks', 1);
    });

    it('should return empty array when no results found', async () => {
      mockGraphDb.searchResources.mockResolvedValue([]);

      const result = await GraphContext.searchResources('nonexistent topic', mockConfig);

      expect(result).toEqual([]);
    });

    it('should handle special characters in query', async () => {
      mockGraphDb.searchResources.mockResolvedValue([]);

      await GraphContext.searchResources('C++ & Rust', mockConfig);

      expect(mockGraphDb.searchResources).toHaveBeenCalledWith('C++ & Rust', undefined);
    });
  });
});
