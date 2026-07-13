/**
 * Matcher Actor Tests
 *
 * Tests the Matcher's RxJS pipeline:
 * - Search request handling (match:search-requested → match:search-results/match:search-failed)
 * - Context-driven scoring over the unified GatheredContext (focus.kind:'annotation')
 * - Error handling
 * - Lifecycle (stop)
 *
 * CONTEXT-UNIFICATION P4: the matcher reads the unified `GatheredContext` — `focus.annotation`
 * for the anchor, and the flattened views (connections, citedByCount) are derived from the shared
 * `graph` via core `deriveViews`. Fixtures build a `KnowledgeGraph` (via `buildGraph`) so the
 * derivation reproduces the connection/citation signals the scorer reads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, resourceId, type GatheredContext, type Logger, type ResourceId } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';
import type { InferenceClient } from '@semiont/inference';
import { Matcher } from '../matcher';

type AnnotationFocus = Extract<GatheredContext['focus'], { kind: 'annotation' }>;
type KnowledgeGraph = GatheredContext['graph'];

/** Resource id every fixture's graph is anchored on; matches the match event's `resourceId`. */
const MAIN_ID = 'test-resource';

const testAnnotation: AnnotationFocus['annotation'] = {
  id: 'test-ann',
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  motivation: 'linking',
  target: { source: 'test-resource' },
  body: { type: 'SpecificResource', source: '' },
};

const testSourceResource: AnnotationFocus['sourceResource'] = {
  '@context': 'https://schema.org',
  '@id': 'test-resource',
  name: 'Test Resource',
  format: 'text/plain',
  representations: [],
};

/**
 * Build a `KnowledgeGraph` anchored on MAIN_ID from connection/citation intent, so
 * `deriveViews(graph, MAIN_ID)` reproduces the flattened signals the scorer reads:
 * - `connections`: main→peer edges (peer resource nodes), carrying `bidirectional`.
 * - `citedBy`/`citedByCount`: inbound `citation` edges. A citer in `citedByMissing` is an edge
 *   with NO node — a missing-view citer (still counted, per P4 (ii)=A).
 * - `siblingEntityTypes`: annotation nodes attached to the resource.
 */
function buildGraph(opts: {
  connections?: Array<{ resourceId: string; resourceName: string; bidirectional?: boolean; entityTypes?: string[] }>;
  citedByPresent?: Array<{ resourceId: string; resourceName: string }>;
  citedByMissing?: string[];
  siblingAnnotations?: Array<{ id: string; entityTypes?: string[] }>;
} = {}): KnowledgeGraph {
  const nodes: KnowledgeGraph['nodes'] = [
    { id: MAIN_ID, type: 'resource', label: 'Test Resource' },
  ];
  const edges: KnowledgeGraph['edges'] = [];

  for (const c of opts.connections ?? []) {
    nodes.push({ id: c.resourceId, type: 'resource', label: c.resourceName, entityTypes: c.entityTypes });
    edges.push({ source: MAIN_ID, target: c.resourceId, type: 'related', bidirectional: c.bidirectional ?? false });
  }
  for (const c of opts.citedByPresent ?? []) {
    nodes.push({ id: c.resourceId, type: 'resource', label: c.resourceName });
    edges.push({ source: c.resourceId, target: MAIN_ID, type: 'citation' });
  }
  for (const id of opts.citedByMissing ?? []) {
    edges.push({ source: id, target: MAIN_ID, type: 'citation' });
  }
  for (const a of opts.siblingAnnotations ?? []) {
    nodes.push({ id: a.id, type: 'annotation', label: a.id, entityTypes: a.entityTypes });
    edges.push({ source: a.id, target: MAIN_ID, type: 'annotation-of' });
  }
  return { nodes, edges };
}

/** Build a unified GatheredContext (annotation focus) for a match request. */
function makeContext(overrides: {
  selected?: { before?: string; text: string; after?: string };
  userHint?: string;
  metadata?: GatheredContext['metadata'];
  graph?: KnowledgeGraph;
  inferredRelationshipSummary?: string;
} = {}): GatheredContext {
  return {
    focus: {
      kind: 'annotation',
      annotation: testAnnotation,
      sourceResource: testSourceResource,
      selected: overrides.selected ?? { before: '', text: 'test', after: '' },
      ...(overrides.userHint !== undefined ? { userHint: overrides.userHint } : {}),
    },
    graph: overrides.graph ?? buildGraph(),
    metadata: overrides.metadata ?? {},
    ...(overrides.inferredRelationshipSummary !== undefined
      ? { inferredRelationshipSummary: overrides.inferredRelationshipSummary }
      : {}),
  };
}

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const noopInference = {
  type: 'noop',
  modelId: 'noop',
  generateText: vi.fn().mockResolvedValue(''),
  generateTextWithMetadata: vi.fn().mockResolvedValue({ text: '', usage: {} }),
} as unknown as InferenceClient;

interface MockGraphOverrides {
  searchResources?: ReturnType<typeof vi.fn>;
  getResourceReferencedBy?: ReturnType<typeof vi.fn>;
  getResource?: ReturnType<typeof vi.fn>;
  listResources?: ReturnType<typeof vi.fn>;
}

function createMockKb(overrides: MockGraphOverrides = {}): KnowledgeBase {
  return {
    eventStore: {} as any,
    views: {} as any,
    content: {} as any,
    projectionsDir: '',
      weaveProgress: {} as any,
    graph: {
      searchResources: overrides.searchResources ?? vi.fn().mockResolvedValue([]),
      getResourceReferencedBy: overrides.getResourceReferencedBy ?? vi.fn().mockResolvedValue([]),
      getResource: overrides.getResource ?? vi.fn().mockResolvedValue(null),
      listResources: overrides.listResources ?? vi.fn().mockResolvedValue({ resources: [], total: 0 }),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      getBacklinks: vi.fn(),
      findPath: vi.fn(),
      getResourceConnections: vi.fn(),
      disconnect: vi.fn(),
    } as any,
  };
}


describe('Matcher', () => {
  let eventBus: EventBus;
  let matcher: Matcher;
  let mockSearchFn: ReturnType<typeof vi.fn>;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    mockSearchFn = vi.fn();
    kb = createMockKb({ searchResources: mockSearchFn });
    matcher = new Matcher(kb, eventBus, mockLogger, noopInference);
    await matcher.initialize();
  });

  afterEach(async () => {
    await matcher.stop();
    eventBus.destroy();
  });

  describe('search handling', () => {
    it('should emit match:search-results on success', async () => {
      const mockResults = [
        { '@id': 'r1', name: 'Resource 1' },
        { '@id': 'r2', name: 'Resource 2' },
      ];
      mockSearchFn.mockResolvedValue(mockResults);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-1',
        context: makeContext({ selected: { text: 'test query' } }),
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-1');
      expect(result!.response).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ '@id': 'r1', name: 'Resource 1' }),
          expect.objectContaining({ '@id': 'r2', name: 'Resource 2' }),
        ]),
      );
      expect(result!.response).toHaveLength(2);
      // Context-driven search always adds score
      for (const r of result!.response) {
        expect(r).toHaveProperty('score');
      }

      expect(mockSearchFn).toHaveBeenCalledWith('test query');
    });

    it('should emit match:search-failed on error', async () => {
      mockSearchFn.mockRejectedValue(new Error('Graph connection failed'));

      const resultPromise = eventBus.get('match:search-failed').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-2',
        context: makeContext({ selected: { text: 'failing query' } }),
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-2');
      expect(result!.error).toBe('Graph connection failed');
    });

    it('should handle empty search results', async () => {
      mockSearchFn.mockResolvedValue([]);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-3',
        context: makeContext({ selected: { text: 'nonexistent' } }),
      });

      const result = await resultPromise;
      expect(result!.response).toEqual([]);
    });
  });

  describe('context-driven search', () => {
    let mockSearchFn2: ReturnType<typeof vi.fn>;
    let mockListResources: ReturnType<typeof vi.fn>;
    let mockGetResource: ReturnType<typeof vi.fn>;

    const RES_A = { '@id': 'res-a', name: 'Alpha', dateCreated: '2026-01-01T00:00:00Z' };
    const RES_B = { '@id': 'res-b', name: 'Beta', dateCreated: '2026-01-15T00:00:00Z' };
    const RES_C = { '@id': 'res-c', name: 'Gamma', dateCreated: '2026-02-01T00:00:00Z' };

    beforeEach(async () => {
      await matcher.stop();
      eventBus.destroy();

      vi.clearAllMocks();
      eventBus = new EventBus();
      mockSearchFn2 = vi.fn().mockResolvedValue([]);
      mockListResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
      mockGetResource = vi.fn().mockResolvedValue(null);
      kb = createMockKb({
        searchResources: mockSearchFn2,
        listResources: mockListResources,
        getResource: mockGetResource,
      });
      matcher = new Matcher(kb, eventBus, mockLogger, noopInference);
      await matcher.initialize();
    });

    it('should search with minimal context (selected text only)', async () => {
      mockSearchFn2.mockResolvedValue([RES_A]);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-no-ctx',
        context: makeContext({ selected: { text: 'Alpha' } }),
      });

      const result = await resultPromise;
      expect(result!.response).toHaveLength(1);
      expect(result!.response[0]).toMatchObject({ '@id': 'res-a', name: 'Alpha' });
      expect(result!.response[0]).toHaveProperty('score');
      expect(result!.response[0]).toHaveProperty('matchReason');
    });

    it('should score exact name match higher than contains match', async () => {
      mockSearchFn2.mockResolvedValue([RES_A, RES_B]);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-name',
        context: makeContext({ selected: { before: '', text: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
      const alpha = scores.find(r => r.name === 'Alpha');
      const beta = scores.find(r => r.name === 'Beta');
      expect(alpha).toBeDefined();
      expect(alpha!.score).toBeGreaterThan(0);
      // Beta has no name match so its score should be lower
      if (beta) {
        expect(alpha!.score).toBeGreaterThan(beta.score);
      }
      expect(alpha!.matchReason).toContain('exact name match');
    });

    it('should boost candidates with matching entity types', async () => {
      const resWithTypes = {
        ...RES_A,
        entityTypes: ['Person', 'Author'],
      };
      const resWithoutTypes = { ...RES_B };
      mockSearchFn2.mockResolvedValue([resWithTypes, resWithoutTypes]);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-et',
        context: makeContext({
          selected: { before: '', text: 'nonmatching', after: '' }, // no name match — isolate entity type signal
          metadata: { entityTypes: ['Person', 'Author'] },
        }),
      });

      const result = await resultPromise;
      const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
      const alpha = scores.find(r => r.name === 'Alpha');
      expect(alpha).toBeDefined();
      expect(alpha!.matchReason).toContain('entity types');
      expect(alpha!.score).toBeGreaterThan(0);
      // Beta has no entity types — should score lower
      const beta = scores.find(r => r.name === 'Beta');
      if (beta) {
        expect(alpha!.score).toBeGreaterThan(beta.score);
      }
    });

    it('should not gate the vector lane by annotation entity types', async () => {
      // Entity-type overlap is a ranking signal (Jaccard + IDF further down),
      // not an inclusion filter. The vector lane must be free to surface
      // semantically-similar candidates that don't carry the annotation's
      // entity types — the scorer ranks them, the gate would hide them.
      const mockVectorSearch = vi.fn().mockResolvedValue([]);
      (kb as any).vectors = { searchResources: mockVectorSearch };
      const mockEmbed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const embeddingProvider = { embed: mockEmbed, dimension: 3 } as any;

      await matcher.stop();
      matcher = new Matcher(kb, eventBus, mockLogger, noopInference, embeddingProvider);
      await matcher.initialize();

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-no-gate',
        context: makeContext({
          selected: { before: '', text: 'Lincoln', after: '' },
          metadata: { entityTypes: ['Person'] },
        }),
      });

      await resultPromise;

      expect(mockVectorSearch).toHaveBeenCalledTimes(1);
      const opts = mockVectorSearch.mock.calls[0][1];
      expect(opts.filter?.entityTypes).toBeUndefined();
    });

    it('should boost bidirectional connections', async () => {
      // RES_A found via name, RES_B found via name — both match
      // RES_B is also a bidirectional connection
      mockSearchFn2.mockResolvedValue([RES_A, RES_B]);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-bidir',
        context: makeContext({
          selected: { before: '', text: 'test', after: '' },
          graph: buildGraph({
            connections: [{ resourceId: 'res-b', resourceName: 'Beta', bidirectional: true }],
          }),
        }),
      });

      const result = await resultPromise;
      const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
      const beta = scores.find(r => r.name === 'Beta');
      expect(beta).toBeDefined();
      expect(beta!.matchReason).toContain('bidirectional connection');
    });

    it('should include neighborhood candidates from connections', async () => {
      // Name search returns nothing, but connection provides a candidate
      mockSearchFn2.mockResolvedValue([]);
      mockGetResource.mockImplementation((id: ResourceId) => {
        if (id === resourceId('res-c')) return Promise.resolve(RES_C);
        return Promise.resolve(null);
      });

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-neighbor',
        context: makeContext({
          selected: { before: '', text: 'something', after: '' },
          graph: buildGraph({
            connections: [{ resourceId: 'res-c', resourceName: 'Gamma', bidirectional: false }],
          }),
        }),
      });

      const result = await resultPromise;
      expect(result!.response.length).toBeGreaterThanOrEqual(1);
      const gamma = result!.response.find((r: any) => r.name === 'Gamma');
      expect(gamma).toBeDefined();
    });

    it('counts missing-view citers in citedByCount (P4 (ii)=A delta)', async () => {
      // The focal resource is cited by two resources; one citer's node is absent
      // from the graph (its view is missing). Per (ii)=A, `deriveViews` reports the
      // graph as-is — it counts the missing-view citer — so `citedByCount` reflects
      // the full reference history, NOT the old precomputed map that dropped it.
      //
      // Gamma is a neighborhood-only candidate with no name/entity/recency signal, so
      // its score is exactly: connected (+10) + citedBy boost (min(citedByCount*2, 15)).
      // citedByCount = 2 → +4 → 14. The OLD behavior would have dropped the missing-view
      // citer (citedByCount = 1 → +2 → 12); pinning 14 documents the intended rise.
      mockSearchFn2.mockResolvedValue([]);
      mockGetResource.mockImplementation((id: ResourceId) => {
        if (id === resourceId('res-c')) return Promise.resolve({ '@id': 'res-c', name: 'Gamma' });
        return Promise.resolve(null);
      });

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-citedby-delta',
        context: makeContext({
          selected: { before: '', text: 'zzz', after: '' }, // no name match — isolate the citedBy signal
          graph: buildGraph({
            connections: [{ resourceId: 'res-c', resourceName: 'Gamma', bidirectional: false }],
            citedByPresent: [{ resourceId: 'citer-1', resourceName: 'Citer One' }],
            citedByMissing: ['citer-2-missing'],
          }),
        }),
      });

      const result = await resultPromise;
      const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
      const gamma = scores.find(r => r.name === 'Gamma');
      expect(gamma).toBeDefined();
      expect(gamma!.matchReason).toContain('connected');
      expect(gamma!.score).toBe(14);
    });

    it('should give multi-source bonus when candidate found by multiple strategies', async () => {
      // RES_A found by both name search and entity type search
      mockSearchFn2.mockResolvedValue([RES_A]);
      mockListResources.mockResolvedValue({ resources: [RES_A], total: 1 });

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-multi',
        context: makeContext({
          selected: { before: '', text: 'Alpha', after: '' },
          metadata: { entityTypes: ['Person'] },
        }),
      });

      const result = await resultPromise;
      const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
      const alpha = scores.find(r => r.name === 'Alpha');
      expect(alpha).toBeDefined();
      expect(alpha!.matchReason).toContain('retrieval sources');
    });

    it('should sort results by score descending', async () => {
      // RES_A: exact name match = high score
      // RES_B: no name match = low score
      // RES_C: prefix name match = medium score
      const resGamma = { ...RES_C, name: 'Alphaville' }; // prefix match for "Alpha"
      mockSearchFn2.mockResolvedValue([RES_A, RES_B, resGamma]);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-sort',
        context: makeContext({ selected: { before: '', text: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      const scores = result!.response as Array<{ score: number }>;
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1].score).toBeGreaterThanOrEqual(scores[i].score);
      }
    });

    it('should blend inference semantic scores when inferenceClient provided', async () => {
      // Stop matcher without inference, create one with it
      await matcher.stop();
      eventBus.destroy();

      vi.clearAllMocks();
      eventBus = new EventBus();
      mockSearchFn2 = vi.fn().mockResolvedValue([RES_A, RES_B]);
      mockListResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
      mockGetResource = vi.fn().mockResolvedValue(null);
      kb = createMockKb({
        searchResources: mockSearchFn2,
        listResources: mockListResources,
        getResource: mockGetResource,
      });

      const mockInference = {
        type: 'mock' as const,
        modelId: 'mock-model',
        generateText: vi.fn().mockResolvedValue('1. 0.9\n2. 0.2'),
        generateTextWithMetadata: vi.fn(),
      };
      matcher = new Matcher(kb, eventBus, mockLogger, mockInference);
      await matcher.initialize();

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-inference',
        context: makeContext({ selected: { before: '', text: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
      const alpha = scores.find(r => r.name === 'Alpha');
      const beta = scores.find(r => r.name === 'Beta');
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      // Alpha should have higher inference boost (0.9 * 25 = 22.5)
      // Beta should have lower inference boost (0.2 * 25 = 5)
      expect(alpha!.score).toBeGreaterThan(beta!.score);
      expect(alpha!.matchReason).toContain('semantic match');
      expect(mockInference.generateText).toHaveBeenCalledTimes(1);
    });

    it('should gracefully degrade when inference fails', async () => {
      await matcher.stop();
      eventBus.destroy();

      vi.clearAllMocks();
      eventBus = new EventBus();
      mockSearchFn2 = vi.fn().mockResolvedValue([RES_A]);
      mockListResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
      mockGetResource = vi.fn().mockResolvedValue(null);
      kb = createMockKb({
        searchResources: mockSearchFn2,
        listResources: mockListResources,
        getResource: mockGetResource,
      });

      const mockInference = {
        type: 'mock' as const,
        modelId: 'mock-model',
        generateText: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
        generateTextWithMetadata: vi.fn(),
      };
      matcher = new Matcher(kb, eventBus, mockLogger, mockInference);
      await matcher.initialize();

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-inference-fail',
        context: makeContext({ selected: { before: '', text: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      // Should still return results with structural scores only
      expect(result!.response.length).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Inference semantic scoring failed, using structural scores only',
        expect.anything(),
      );
    });

    it('should not call inference when no inferenceClient provided', async () => {
      // Use the default matcher (no inference client)
      mockSearchFn2.mockResolvedValue([RES_A]);

      const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-no-inference',
        context: makeContext({ selected: { before: '', text: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      expect(result!.response.length).toBe(1);
      // No inference call — score is purely structural
      const alpha = result!.response[0] as any;
      expect(alpha.matchReason).not.toContain('semantic match');
    });

    it('should emit search-failed when context search throws', async () => {
      mockSearchFn2.mockRejectedValue(new Error('DB down'));

      const resultPromise = eventBus.get('match:search-failed').pipe(take(1)).toPromise();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-fail',
        context: makeContext({ selected: { before: '', text: 'anything', after: '' } }),
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-fail');
      expect(result!.error).toBe('DB down');
    });

    describe('inference response parsing edge cases', () => {
      let mockInference: { type: string; modelId: string; generateText: ReturnType<typeof vi.fn>; generateTextWithMetadata: ReturnType<typeof vi.fn> };

      beforeEach(async () => {
        await matcher.stop();
        eventBus.destroy();

        vi.clearAllMocks();
        eventBus = new EventBus();
        mockSearchFn2 = vi.fn().mockResolvedValue([RES_A, RES_B, RES_C]);
        mockListResources = vi.fn().mockResolvedValue({ resources: [], total: 0 });
        mockGetResource = vi.fn().mockResolvedValue(null);
        kb = createMockKb({
          searchResources: mockSearchFn2,
          listResources: mockListResources,
          getResource: mockGetResource,
        });

        mockInference = {
          type: 'mock',
          modelId: 'mock-model',
          generateText: vi.fn(),
          generateTextWithMetadata: vi.fn(),
        };
        matcher = new Matcher(kb, eventBus, mockLogger, mockInference as InferenceClient);
        await matcher.initialize();
      });

      it('should drop scores outside 0-1 range', async () => {
        // Score > 1 should be ignored, score < 0 should be ignored
        mockInference.generateText.mockResolvedValue('1. 1.5\n2. -0.3\n3. 0.7');

        const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

        eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
          correlationId: 'test-corr-id',
          referenceId: 'ref-range',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
        // Only Gamma (index 2, score 0.7) should get semantic boost
        const gamma = scores.find(r => r.name === 'Gamma');
        expect(gamma!.matchReason).toContain('semantic match');
        // Alpha and Beta should NOT have semantic match (their scores were out of range)
        const alpha = scores.find(r => r.name === 'Alpha');
        const beta = scores.find(r => r.name === 'Beta');
        expect(alpha!.matchReason).not.toContain('semantic match');
        expect(beta!.matchReason).not.toContain('semantic match');
      });

      it('should handle malformed response lines gracefully', async () => {
        mockInference.generateText.mockResolvedValue(
          'Here are my scores:\n1. 0.8\nThis is not a score line\n2. invalid\n3. 0.5'
        );

        const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

        eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
          correlationId: 'test-corr-id',
          referenceId: 'ref-malformed',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
        // Only Alpha (index 0) should get semantic match (0.8 > 0.5)
        const alpha = scores.find(r => r.name === 'Alpha');
        expect(alpha!.matchReason).toContain('semantic match');
        // Gamma (index 2, score 0.5) is not > 0.5
        const gamma = scores.find(r => r.name === 'Gamma');
        expect(gamma!.matchReason).not.toContain('semantic match');
      });

      it('should handle empty inference response', async () => {
        mockInference.generateText.mockResolvedValue('');

        const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

        eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
          correlationId: 'test-corr-id',
          referenceId: 'ref-empty',
          context: makeContext({ selected: { before: '', text: 'Alpha', after: '' } }),
        });

        const result = await resultPromise;
        // Should still return results with structural scores only
        expect(result!.response.length).toBe(3);
        const alpha = result!.response.find((r: any) => r.name === 'Alpha') as any;
        expect(alpha.matchReason).not.toContain('semantic match');
      });

      it('should handle out-of-bounds indices', async () => {
        // Index 5 doesn't exist (only 3 candidates)
        mockInference.generateText.mockResolvedValue('1. 0.8\n5. 0.9\n3. 0.6');

        const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

        eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
          correlationId: 'test-corr-id',
          referenceId: 'ref-oob',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
        // Alpha (index 0) should get boost, Gamma (index 2) should get boost
        // Index 4 (5th candidate) doesn't exist, should be silently ignored
        const alpha = scores.find(r => r.name === 'Alpha');
        expect(alpha!.matchReason).toContain('semantic match');
      });

      it('should not add semantic match reason when score is exactly 0.5', async () => {
        mockInference.generateText.mockResolvedValue('1. 0.5\n2. 0.51\n3. 0.49');

        const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

        eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
          correlationId: 'test-corr-id',
          referenceId: 'ref-threshold',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.response as unknown as Array<{ name: string; score: number; matchReason: string }>;
        const alpha = scores.find(r => r.name === 'Alpha');
        const beta = scores.find(r => r.name === 'Beta');
        const gamma = scores.find(r => r.name === 'Gamma');
        // 0.5 is not > 0.5
        expect(alpha!.matchReason).not.toContain('semantic match');
        // 0.51 > 0.5
        expect(beta!.matchReason).toContain('semantic match');
        // 0.49 is not > 0.5
        expect(gamma!.matchReason).not.toContain('semantic match');
      });

      it('should include inferredRelationshipSummary in semantic scoring prompt', async () => {
        mockInference.generateText.mockResolvedValue('1. 0.8\n2. 0.3\n3. 0.5');

        const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

        const summary = 'This passage discusses Greek mythology figures.';
        eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
          correlationId: 'test-corr-id',
          referenceId: 'ref-summary',
          context: makeContext({
            selected: { before: '', text: 'Zeus', after: '' },
            graph: buildGraph({
              connections: [{ resourceId: 'r1', resourceName: 'Olympus', bidirectional: false }],
            }),
            inferredRelationshipSummary: summary,
          }),
        });

        await resultPromise;
        const prompt = mockInference.generateText.mock.calls[0][0] as string;
        expect(prompt).toContain(summary);
        expect(prompt).toContain('Olympus');
      });

      it('should pass passage text and entity types to semantic scoring prompt', async () => {
        mockInference.generateText.mockResolvedValue('1. 0.5');

        const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();

        eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
          correlationId: 'test-corr-id',
          referenceId: 'ref-passage',
          context: makeContext({
            selected: { before: 'In the beginning,', text: 'Zeus ruled the heavens', after: 'and the earth.' },
            metadata: { entityTypes: ['Person', 'Deity'] },
          }),
        });

        await resultPromise;
        const prompt = mockInference.generateText.mock.calls[0][0] as string;
        expect(prompt).toContain('Zeus ruled the heavens');
        expect(prompt).toContain('Person');
        expect(prompt).toContain('Deity');
      });
    });
  });

  describe('lifecycle', () => {
    it('should stop cleanly', async () => {
      await matcher.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Matcher actor stopped');
    });

    it('should not process events after stop', async () => {
      await matcher.stop();

      eventBus.get('match:search-requested').next({
        resourceId: 'test-resource',
        correlationId: 'test-corr-id',
        referenceId: 'ref-4',
        context: makeContext({ selected: { text: 'after stop' } }),
      });

      // Give time for any processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockSearchFn).not.toHaveBeenCalled();
    });
  });
});
