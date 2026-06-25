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
  getResource: vi.fn(),
  getResourceReferencedBy: vi.fn(),
  getResourceAnnotations: vi.fn(),
  findPath: vi.fn(),
  getResourceConnections: vi.fn(),
  searchResources: vi.fn()
};

const mockViews = { get: vi.fn() };

describe('GraphContext', () => {
  const mockKb: KnowledgeBase = {
    eventStore: {} as any,
    views: mockViews as any,
    content: {} as any,
    graph: mockGraphDb as any,
    projectionsDir: '',
      graphConsumer: {} as any,
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

  describe('buildKnowledgeGraph (CONTEXT-UNIFICATION P2)', () => {
    const mainDoc = { '@id': 'res-main', name: 'Main', entityTypes: ['Paper'] };
    const peerDoc = { '@id': 'res-peer', name: 'Peer', entityTypes: ['Author'] };

    function setup(opts: {
      connections?: any[];
      referencedBy?: any[];
      annotations?: any[];
      views?: Record<string, any>;
    }) {
      mockGraphDb.getResource.mockResolvedValue(mainDoc);
      mockGraphDb.getResourceConnections.mockResolvedValue(opts.connections ?? []);
      mockGraphDb.getResourceReferencedBy.mockResolvedValue(opts.referencedBy ?? []);
      mockGraphDb.getResourceAnnotations.mockResolvedValue(opts.annotations ?? []);
      mockViews.get.mockImplementation(async (id: any) => opts.views?.[String(id)] ?? null);
    }

    it('throws when the main resource is missing', async () => {
      mockGraphDb.getResource.mockResolvedValue(null);
      mockGraphDb.getResourceConnections.mockResolvedValue([]);
      mockGraphDb.getResourceReferencedBy.mockResolvedValue([]);
      mockGraphDb.getResourceAnnotations.mockResolvedValue([]);
      await expect(
        GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb),
      ).rejects.toThrow('Resource not found');
    });

    it('includes annotation nodes, not just resources (D2)', async () => {
      setup({
        annotations: [
          { id: 'ann-1', motivation: 'commenting', body: [] },
          { id: 'ann-2', motivation: 'linking', body: [] },
        ],
      });

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      const annotationNodes = graph.nodes.filter((n) => n.type === 'annotation');
      expect(annotationNodes.map((n) => n.id).sort()).toEqual(['ann-1', 'ann-2']);
      // every node carries the discriminator
      expect(graph.nodes.every((n) => n.type === 'resource' || n.type === 'annotation')).toBe(true);
    });

    it('emits a citation as an inbound edge so citedBy/count are derivable', async () => {
      setup({
        referencedBy: [{ id: 'ann-cite', target: { source: 'res-citing' }, body: [] }],
        views: { 'res-citing': { resource: { '@id': 'res-citing', name: 'Citing Paper', entityTypes: [] } } },
      });

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      // citing resource is a node...
      expect(graph.nodes.find((n) => n.id === 'res-citing')).toMatchObject({ type: 'resource', label: 'Citing Paper' });
      // ...and the citation is an INBOUND edge (source = citing, target = main)
      const citationEdges = graph.edges.filter((e) => e.type === 'citation');
      expect(citationEdges).toEqual([{ source: 'res-citing', target: 'res-main', type: 'citation' }]);
      // citedByCount = inbound citation edge count
      expect(citationEdges.length).toBe(1);
    });

    it('carries bidirectional as an edge property', async () => {
      setup({
        connections: [
          { targetResource: peerDoc, annotations: [], relationshipType: 'cites', bidirectional: true },
        ],
      });

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      const peerEdge = graph.edges.find((e) => e.target === 'res-peer');
      expect(peerEdge).toMatchObject({ source: 'res-main', target: 'res-peer', type: 'cites', bidirectional: true });
    });

    it('includes sibling annotations as nodes with an annotation-of edge to the resource', async () => {
      setup({
        annotations: [{ id: 'ann-sib', motivation: 'commenting', body: [] }],
      });

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      expect(graph.nodes.find((n) => n.id === 'ann-sib')).toMatchObject({ type: 'annotation' });
      expect(graph.edges).toContainEqual({ source: 'ann-sib', target: 'res-main', type: 'annotation-of' });
    });
  });
});
