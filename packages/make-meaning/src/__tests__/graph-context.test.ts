/**
 * Graph Context Tests
 *
 * Tests the GraphContext class which provides graph database operations
 * for resources and annotations.
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphContext, type KnowledgeGraphReads } from '../graph-context';
import { resourceId, type Logger } from '@semiont/core';
import { WeaveProgressTimeout } from '../weave-progress';

const mockGraphDb = {
  getResource: vi.fn(),
  getResourceReferencedBy: vi.fn(),
  getResourceAnnotations: vi.fn(),
  getResourceConnections: vi.fn()
};

const mockViews = { get: vi.fn() };

const mockWeaveProgress = { whenApplied: vi.fn() };

describe('GraphContext', () => {
  const mockKb: KnowledgeGraphReads = {
    views: mockViews as KnowledgeGraphReads['views'],
    graph: mockGraphDb as KnowledgeGraphReads['graph'],
    weaveProgress: mockWeaveProgress as KnowledgeGraphReads['weaveProgress'],
  };

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

    it('emits an inbound citation as its linking annotation: an embedded node anchored by annotation-of + cites (D12)', async () => {
      const citing = { id: 'ann-cite', motivation: 'linking', target: { source: 'res-citing' }, body: [] };
      setup({
        referencedBy: [citing],
        views: { 'res-citing': { resource: { '@id': 'res-citing', name: 'Citing Paper', entityTypes: [] } } },
      });

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      // citing resource is still a node...
      expect(graph.nodes.find((n) => n.id === 'res-citing')).toMatchObject({ type: 'resource', label: 'Citing Paper' });
      // ...the linking annotation is the citation's graph presence, embedded whole (D11)...
      expect(graph.nodes.find((n) => n.id === 'ann-cite')).toMatchObject({ type: 'annotation', label: 'linking', annotation: citing });
      // ...anchored to its citing resource and to the focal resource
      expect(graph.edges).toContainEqual({ source: 'ann-cite', target: 'res-citing', type: 'annotation-of' });
      expect(graph.edges).toContainEqual({ source: 'ann-cite', target: 'res-main', type: 'cites' });
      // the flattened resource→resource citation edge is GONE
      expect(graph.edges.filter((e) => e.type === 'citation')).toEqual([]);
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

      expect(graph.nodes.find((n) => n.id === 'ann-sib')).toMatchObject({
        type: 'annotation',
        annotation: { id: 'ann-sib', motivation: 'commenting' }, // embedded whole (D11)
      });
      expect(graph.edges).toContainEqual({ source: 'ann-sib', target: 'res-main', type: 'annotation-of' });
    });
  });

  describe('projection-lag grace (GRAPH-PROJECTION-SYNC P1)', () => {
    const mainDoc = { '@id': 'res-main', name: 'Main', entityTypes: [] };

    it('retries the graph read while the view has the resource, and succeeds once the Weaver catches up', async () => {
      // The view materializer applies on the append path; the Weaver lags.
      // "In the view, not yet in the graph" is projection lag, not a 404.
      mockViews.get.mockReset().mockResolvedValue({ resource: mainDoc });
      mockGraphDb.getResource
        .mockReset()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(mainDoc);
      mockGraphDb.getResourceConnections.mockResolvedValue([]);
      mockGraphDb.getResourceReferencedBy.mockResolvedValue([]);
      mockGraphDb.getResourceAnnotations.mockResolvedValue([]);

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      expect(graph.nodes.find((n) => n.id === 'res-main')).toMatchObject({ type: 'resource', label: 'Main' });
      expect(mockGraphDb.getResource.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('does not retry when the view lacks the resource — a true unknown throws on the first read', async () => {
      mockViews.get.mockReset().mockResolvedValue(null);
      mockGraphDb.getResource.mockReset().mockResolvedValue(null);

      await expect(
        GraphContext.buildKnowledgeGraph(resourceId('res-ghost'), mockKb),
      ).rejects.toThrow('Resource not found');
      expect(mockGraphDb.getResource).toHaveBeenCalledTimes(1);
    });

    it('exhaustion with the view still vouching is PROJECTION LAG — honestly named, breadcrumbed, counted; never "Resource not found"', async () => {
      // The view has the resource; the graph never catches up. Calling that
      // "Resource not found" is a lie — it misdirects debugging at a 404 when
      // the actual fault is a lagging/stalled Weaver. The degrade must be
      // distinguishable (distinct error), loggable (one [gather DEGRADED]
      // breadcrumb), and countable (recordGatherDegrade('graph')).
      mockViews.get.mockReset().mockResolvedValue({ resource: mainDoc });
      mockGraphDb.getResource.mockReset().mockResolvedValue(null);
      const degradeLogger: Logger = {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => degradeLogger),
      };

      await expect(
        GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb, degradeLogger),
      ).rejects.toThrow(/projection did not catch up/);
      // Bounded: more than one attempt, but not unbounded polling.
      expect(mockGraphDb.getResource.mock.calls.length).toBeGreaterThan(1);
      expect(mockGraphDb.getResource.mock.calls.length).toBeLessThanOrEqual(6);
      const breadcrumbs = (degradeLogger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter(([message]) => String(message).includes('[gather DEGRADED]'));
      expect(breadcrumbs).toHaveLength(1);
    });

    it('rethrows a non-timeout barrier failure — a broken progress fold must surface, not silently poll', async () => {
      mockViews.get.mockReset().mockResolvedValue({ resource: mainDoc, lastSequence: 7 });
      mockWeaveProgress.whenApplied.mockReset().mockRejectedValue(new Error('progress fold wedged'));
      mockGraphDb.getResource.mockReset().mockResolvedValue(null);

      await expect(
        GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb),
      ).rejects.toThrow('progress fold wedged');
    });
  });

  describe('applied-offset barrier (GRAPH-PROJECTION-SYNC P2, D2 = push)', () => {
    const mainDoc = { '@id': 'res-main', name: 'Main', entityTypes: [] };

    it('awaits weave:applied parity and re-reads once — zero backoff polls', async () => {
      // The view carries its applied sequence; the barrier waits for the
      // Weaver to report parity, then a single re-read hits. No sleep-poll
      // iterations — the wake is event-driven.
      mockViews.get.mockReset().mockResolvedValue({ resource: mainDoc, lastSequence: 7 });
      mockWeaveProgress.whenApplied.mockReset().mockResolvedValue(undefined);
      mockGraphDb.getResource
        .mockReset()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(mainDoc);
      mockGraphDb.getResourceConnections.mockResolvedValue([]);
      mockGraphDb.getResourceReferencedBy.mockResolvedValue([]);
      mockGraphDb.getResourceAnnotations.mockResolvedValue([]);

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      expect(graph.nodes.find((n) => n.id === 'res-main')).toMatchObject({ type: 'resource' });
      expect(mockWeaveProgress.whenApplied).toHaveBeenCalledTimes(1);
      expect(mockWeaveProgress.whenApplied).toHaveBeenCalledWith('res-main', 7, expect.any(Number));
      expect(mockGraphDb.getResource).toHaveBeenCalledTimes(2);
    });

    it('falls back to the bounded poll when the barrier times out', async () => {
      mockViews.get.mockReset().mockResolvedValue({ resource: mainDoc, lastSequence: 7 });
      // A REAL WeaveProgressTimeout instance: the barrier discriminates by
      // type — only its own timeout downgrades to polling (a lookalike
      // message on a plain Error must rethrow, see the sibling test).
      mockWeaveProgress.whenApplied.mockReset().mockRejectedValue(new WeaveProgressTimeout('res-main', 7, 500));
      mockGraphDb.getResource
        .mockReset()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(mainDoc);

      const graph = await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      expect(graph.nodes.find((n) => n.id === 'res-main')).toMatchObject({ type: 'resource' });
      expect(mockGraphDb.getResource.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('skips the barrier for views without a sequence stamp — straight to the poll floor', async () => {
      // Pre-stamp view files (written before lastSequence existed) carry no
      // parity target; the barrier cannot engage and must not block.
      mockViews.get.mockReset().mockResolvedValue({ resource: mainDoc });
      mockWeaveProgress.whenApplied.mockReset().mockResolvedValue(undefined);
      mockGraphDb.getResource
        .mockReset()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(mainDoc);

      await GraphContext.buildKnowledgeGraph(resourceId('res-main'), mockKb);

      expect(mockWeaveProgress.whenApplied).not.toHaveBeenCalled();
    });
  });
});
