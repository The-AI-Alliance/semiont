/**
 * Graph Context Tests
 *
 * Tests the GraphContext class which provides graph database operations
 * for resources and annotations.
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphContext } from '../graph-context';
import { resourceId, type EnvironmentConfig } from '@semiont/core';

// Mock @semiont/graph
const mockGraphDb = {
  getResourceReferencedBy: vi.fn(),
  findPath: vi.fn(),
  getResourceConnections: vi.fn(),
  searchResources: vi.fn()
};

vi.mock('@semiont/graph', () => {
  return {
    getGraphDatabase: vi.fn().mockResolvedValue(mockGraphDb)
  };
});

describe('GraphContext', () => {
  const config: EnvironmentConfig = {
    services: {
      backend: {
        platform: { type: 'posix' },
        port: 4000,
        publicURL: 'http://localhost:4000',
        corsOrigin: 'http://localhost:3000'
      },
      graph: {
        platform: { type: 'posix' },
        type: 'memory'
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

  it('should get backlinks for a resource', async () => {
    mockGraphDb.getResourceReferencedBy.mockResolvedValue([
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        id: 'http://localhost:4000/annotations/ann1',
        type: 'Annotation',
        motivation: 'linking',
        body: 'Reference text',
        target: 'http://localhost:4000/resources/source'
      }
    ]);

    const result = await GraphContext.getBacklinks(resourceId('test-resource'), config);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('id');
    expect(mockGraphDb.getResourceReferencedBy).toHaveBeenCalledWith(
      'http://localhost:4000/resources/test-resource'
    );
  });

  it('should find path between resources', async () => {
    mockGraphDb.findPath.mockResolvedValue([
      {
        fromResource: resourceId('res1'),
        toResource: resourceId('res2'),
        depth: 1,
        connections: [
          {
            source: resourceId('res1'),
            target: resourceId('res2'),
            via: 'annotation-1'
          }
        ]
      }
    ]);

    const result = await GraphContext.findPath(
      resourceId('res1'),
      resourceId('res2'),
      config,
      3
    );

    expect(result).toHaveLength(1);
    expect(result[0].connections.length).toBe(1);
    expect(mockGraphDb.findPath).toHaveBeenCalledWith(
      resourceId('res1'),
      resourceId('res2'),
      3
    );
  });

  it('should get resource connections', async () => {
    mockGraphDb.getResourceConnections.mockResolvedValue([
      {
        source: resourceId('test'),
        target: resourceId('target1'),
        via: 'annotation-1'
      },
      {
        source: resourceId('test'),
        target: resourceId('target2'),
        via: 'annotation-2'
      }
    ]);

    const result = await GraphContext.getResourceConnections(resourceId('test'), config);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('source');
    expect(result[0]).toHaveProperty('target');
    expect(result[0]).toHaveProperty('via');
    expect(mockGraphDb.getResourceConnections).toHaveBeenCalledWith(resourceId('test'));
  });

  it('should search resources by query', async () => {
    mockGraphDb.searchResources.mockResolvedValue([
      {
        id: 'http://localhost:4000/resources/match1',
        name: 'Matching Resource 1',
        format: 'text/plain',
        createdAt: '2024-01-01T00:00:00Z'
      },
      {
        id: 'http://localhost:4000/resources/match2',
        name: 'Matching Resource 2',
        format: 'text/plain',
        createdAt: '2024-01-02T00:00:00Z'
      }
    ]);

    const result = await GraphContext.searchResources('test query', config, 10);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Matching Resource 1');
    expect(result[1].name).toBe('Matching Resource 2');
    expect(mockGraphDb.searchResources).toHaveBeenCalledWith('test query', 10);
  });

  it('should handle empty backlinks', async () => {
    mockGraphDb.getResourceReferencedBy.mockResolvedValue([]);

    const result = await GraphContext.getBacklinks(resourceId('no-backlinks'), config);

    expect(result).toEqual([]);
  });

  it('should handle no path found', async () => {
    mockGraphDb.findPath.mockResolvedValue([]);

    const result = await GraphContext.findPath(
      resourceId('isolated1'),
      resourceId('isolated2'),
      config
    );

    expect(result).toEqual([]);
  });

  it('should handle search with no results', async () => {
    mockGraphDb.searchResources.mockResolvedValue([]);

    const result = await GraphContext.searchResources('nonexistent query', config);

    expect(result).toEqual([]);
  });

  it('should call findPath without maxDepth when not provided', async () => {
    mockGraphDb.findPath.mockResolvedValue([]);

    await GraphContext.findPath(
      resourceId('from'),
      resourceId('to'),
      config
    );

    expect(mockGraphDb.findPath).toHaveBeenCalledWith(
      resourceId('from'),
      resourceId('to'),
      undefined
    );
  });

  it('should call searchResources without limit when not provided', async () => {
    mockGraphDb.searchResources.mockResolvedValue([]);

    await GraphContext.searchResources('query', config);

    expect(mockGraphDb.searchResources).toHaveBeenCalledWith('query', undefined);
  });
});
