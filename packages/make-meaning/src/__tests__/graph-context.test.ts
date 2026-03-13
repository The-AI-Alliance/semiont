/**
 * Graph Context Tests
 *
 * Tests the GraphContext class which provides graph database operations
 * for resources and annotations.
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphContext } from '../graph-context';
import { resourceId } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';

const mockGraphDb = {
  getResourceReferencedBy: vi.fn(),
  findPath: vi.fn(),
  getResourceConnections: vi.fn(),
  searchResources: vi.fn()
};

describe('GraphContext', () => {
  const mockKb: KnowledgeBase = {
    eventStore: {} as any,
    views: {} as any,
    content: {} as any,
    graph: mockGraphDb as any,
  };

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

    const result = await GraphContext.getBacklinks(resourceId('test-resource'), mockKb);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('id');
    expect(mockGraphDb.getResourceReferencedBy).toHaveBeenCalledWith(
      resourceId('test-resource')
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
      mockKb,
      3
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fromResource: resourceId('res1'),
      toResource: resourceId('res2'),
      depth: 1
    });
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

    const result = await GraphContext.getResourceConnections(resourceId('test'), mockKb);

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

    const result = await GraphContext.searchResources('test query', mockKb, 10);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Matching Resource 1');
    expect(result[1].name).toBe('Matching Resource 2');
    expect(mockGraphDb.searchResources).toHaveBeenCalledWith('test query', 10);
  });

  it('should handle empty backlinks', async () => {
    mockGraphDb.getResourceReferencedBy.mockResolvedValue([]);

    const result = await GraphContext.getBacklinks(resourceId('no-backlinks'), mockKb);

    expect(result).toEqual([]);
  });

  it('should handle no path found', async () => {
    mockGraphDb.findPath.mockResolvedValue([]);

    const result = await GraphContext.findPath(
      resourceId('isolated1'),
      resourceId('isolated2'),
      mockKb
    );

    expect(result).toEqual([]);
  });

  it('should handle search with no results', async () => {
    mockGraphDb.searchResources.mockResolvedValue([]);

    const result = await GraphContext.searchResources('nonexistent query', mockKb);

    expect(result).toEqual([]);
  });

  it('should call findPath without maxDepth when not provided', async () => {
    mockGraphDb.findPath.mockResolvedValue([]);

    await GraphContext.findPath(
      resourceId('from'),
      resourceId('to'),
      mockKb
    );

    expect(mockGraphDb.findPath).toHaveBeenCalledWith(
      resourceId('from'),
      resourceId('to'),
      undefined
    );
  });

  it('should call searchResources without limit when not provided', async () => {
    mockGraphDb.searchResources.mockResolvedValue([]);

    await GraphContext.searchResources('query', mockKb);

    expect(mockGraphDb.searchResources).toHaveBeenCalledWith('query', undefined);
  });
});
