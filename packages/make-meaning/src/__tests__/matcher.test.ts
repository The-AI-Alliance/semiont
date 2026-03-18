/**
 * Matcher Actor Tests
 *
 * Tests the Matcher's RxJS pipeline:
 * - Search request handling (bind:search-requested → bind:search-results/bind:search-failed)
 * - Referenced-by handling (bind:referenced-by-requested → bind:referenced-by-result/bind:referenced-by-failed)
 * - Error handling
 * - Lifecycle (stop)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, resourceId, type GatheredContext, type Logger, type ResourceId } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';
import type { InferenceClient } from '@semiont/inference';
import { Matcher } from '../matcher';

const testAnnotation: GatheredContext['annotation'] = {
  id: 'test-ann',
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  motivation: 'linking',
  target: { source: 'test-resource' },
  body: { type: 'SpecificResource', source: '' },
};

const testSourceResource: GatheredContext['sourceResource'] = {
  '@context': 'https://schema.org',
  '@id': 'test-resource',
  name: 'Test Resource',
  format: 'text/plain',
  representations: [],
};

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

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

/** Build a W3C-shaped annotation with object target (source + selector) */
function makeAnnotation(id: string, targetSource: string, bodySource: string, exact = 'selected text') {
  return {
    id,
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    motivation: 'linking',
    target: {
      source: targetSource,
      selector: [{ type: 'TextQuoteSelector', exact }],
    },
    body: {
      source: bodySource,
    },
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
    matcher = new Matcher(kb, eventBus, mockLogger);
    await matcher.initialize();
  });

  afterEach(async () => {
    await matcher.stop();
    eventBus.destroy();
  });

  describe('search handling', () => {
    it('should emit bind:search-results on success', async () => {
      const mockResults = [
        { '@id': 'r1', name: 'Resource 1' },
        { '@id': 'r2', name: 'Resource 2' },
      ];
      mockSearchFn.mockResolvedValue(mockResults);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-1',
        context: { annotation: testAnnotation, sourceResource: testSourceResource, sourceContext: { selected: 'test query' } },
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-1');
      expect(result!.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ '@id': 'r1', name: 'Resource 1' }),
          expect.objectContaining({ '@id': 'r2', name: 'Resource 2' }),
        ]),
      );
      expect(result!.results).toHaveLength(2);
      // Context-driven search always adds score
      for (const r of result!.results) {
        expect(r).toHaveProperty('score');
      }

      expect(mockSearchFn).toHaveBeenCalledWith('test query');
    });

    it('should emit bind:search-failed on error', async () => {
      mockSearchFn.mockRejectedValue(new Error('Graph connection failed'));

      const resultPromise = eventBus.get('bind:search-failed').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-2',
        context: { annotation: testAnnotation, sourceResource: testSourceResource, sourceContext: { selected: 'failing query' } },
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-2');
      expect(result!.error.message).toBe('Graph connection failed');
    });

    it('should handle empty search results', async () => {
      mockSearchFn.mockResolvedValue([]);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-3',
        context: { annotation: testAnnotation, sourceResource: testSourceResource, sourceContext: { selected: 'nonexistent' } },
      });

      const result = await resultPromise;
      expect(result!.results).toEqual([]);
    });
  });

  describe('referenced-by handling', () => {
    const DOC_A_URI = 'doc-a';
    const DOC_B_URI = 'doc-b';
    const TARGET_RESOURCE_ID = resourceId('target-res');

    let mockReferencedBy: ReturnType<typeof vi.fn>;
    let mockGetResource: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      // Stop the matcher created in outer beforeEach (uses search-only KB)
      await matcher.stop();
      eventBus.destroy();

      vi.clearAllMocks();
      eventBus = new EventBus();
      mockReferencedBy = vi.fn();
      mockGetResource = vi.fn();
      kb = createMockKb({
        getResourceReferencedBy: mockReferencedBy,
        getResource: mockGetResource,
      });
      matcher = new Matcher(kb, eventBus, mockLogger);
      await matcher.initialize();
    });

    it('should emit referenced-by-result with resource names and selectors', async () => {
      const anno1 = makeAnnotation('anno-1', DOC_A_URI, TARGET_RESOURCE_ID, 'Prometheus');
      const anno2 = makeAnnotation('anno-2', DOC_B_URI, TARGET_RESOURCE_ID, 'the Titan');

      mockReferencedBy.mockResolvedValue([anno1, anno2]);
      mockGetResource.mockImplementation((id: ResourceId) => {
        if (id === resourceId('doc-a')) return Promise.resolve({ '@id': DOC_A_URI, name: 'Prometheus Bound' });
        if (id === resourceId('doc-b')) return Promise.resolve({ '@id': DOC_B_URI, name: 'Greek Myths' });
        return Promise.resolve(null);
      });

      const resultPromise = eventBus.get('bind:referenced-by-result').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-1',
        resourceId: TARGET_RESOURCE_ID,
      });

      const result = await resultPromise;
      expect(result!.correlationId).toBe('corr-1');

      const refs = result!.response.referencedBy;
      expect(refs).toHaveLength(2);

      expect(refs[0]).toEqual({
        id: 'anno-1',
        resourceName: 'Prometheus Bound',
        target: { source: DOC_A_URI, selector: { exact: 'Prometheus' } },
      });
      expect(refs[1]).toEqual({
        id: 'anno-2',
        resourceName: 'Greek Myths',
        target: { source: DOC_B_URI, selector: { exact: 'the Titan' } },
      });

      expect(mockReferencedBy).toHaveBeenCalledWith(TARGET_RESOURCE_ID, undefined);
    });

    it('should pass motivation filter to graph query', async () => {
      mockReferencedBy.mockResolvedValue([]);

      const resultPromise = eventBus.get('bind:referenced-by-result').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-2',
        resourceId: TARGET_RESOURCE_ID,
        motivation: 'linking',
      });

      await resultPromise;
      expect(mockReferencedBy).toHaveBeenCalledWith(TARGET_RESOURCE_ID, 'linking');
    });

    it('should handle empty referenced-by results', async () => {
      mockReferencedBy.mockResolvedValue([]);

      const resultPromise = eventBus.get('bind:referenced-by-result').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-3',
        resourceId: TARGET_RESOURCE_ID,
      });

      const result = await resultPromise;
      expect(result!.response.referencedBy).toEqual([]);
      expect(mockGetResource).not.toHaveBeenCalled();
    });

    it('should deduplicate source resource lookups', async () => {
      // Two annotations on the same document
      const anno1 = makeAnnotation('anno-1', DOC_A_URI, TARGET_RESOURCE_ID, 'first mention');
      const anno2 = makeAnnotation('anno-2', DOC_A_URI, TARGET_RESOURCE_ID, 'second mention');

      mockReferencedBy.mockResolvedValue([anno1, anno2]);
      mockGetResource.mockResolvedValue({ '@id': DOC_A_URI, name: 'Prometheus Bound' });

      const resultPromise = eventBus.get('bind:referenced-by-result').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-4',
        resourceId: TARGET_RESOURCE_ID,
      });

      const result = await resultPromise;
      expect(result!.response.referencedBy).toHaveLength(2);
      // Only one getResource call despite two annotations on the same doc
      expect(mockGetResource).toHaveBeenCalledTimes(1);
    });

    it('should use "Untitled Resource" when source resource is missing', async () => {
      const anno = makeAnnotation('anno-1', DOC_A_URI, TARGET_RESOURCE_ID, 'orphan ref');
      mockReferencedBy.mockResolvedValue([anno]);
      mockGetResource.mockResolvedValue(null);

      const resultPromise = eventBus.get('bind:referenced-by-result').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-5',
        resourceId: TARGET_RESOURCE_ID,
      });

      const result = await resultPromise;
      expect(result!.response.referencedBy[0].resourceName).toBe('Untitled Resource');
    });

    it('should handle annotations with string target (no selector)', async () => {
      const anno = {
        id: 'anno-1',
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        motivation: 'linking',
        target: DOC_A_URI, // string target, no selector
        body: { source: String(TARGET_RESOURCE_ID) },
      };

      mockReferencedBy.mockResolvedValue([anno]);
      mockGetResource.mockResolvedValue({ '@id': DOC_A_URI, name: 'Prometheus Bound' });

      const resultPromise = eventBus.get('bind:referenced-by-result').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-6',
        resourceId: TARGET_RESOURCE_ID,
      });

      const result = await resultPromise;
      const ref = result!.response.referencedBy[0];
      expect(ref.resourceName).toBe('Prometheus Bound');
      expect(ref.target.source).toBe(DOC_A_URI);
      expect(ref.target.selector.exact).toBe('');
    });

    it('should emit referenced-by-failed on graph error', async () => {
      mockReferencedBy.mockRejectedValue(new Error('Graph unavailable'));

      const resultPromise = eventBus.get('bind:referenced-by-failed').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-7',
        resourceId: TARGET_RESOURCE_ID,
      });

      const result = await resultPromise;
      expect(result!.correlationId).toBe('corr-7');
      expect(result!.error.message).toBe('Graph unavailable');
    });

    it('should emit referenced-by-failed when getResource throws', async () => {
      const anno = makeAnnotation('anno-1', DOC_A_URI, TARGET_RESOURCE_ID, 'text');
      mockReferencedBy.mockResolvedValue([anno]);
      mockGetResource.mockRejectedValue(new Error('Resource lookup failed'));

      const resultPromise = eventBus.get('bind:referenced-by-failed').pipe(take(1)).toPromise();

      eventBus.get('bind:referenced-by-requested').next({
        correlationId: 'corr-8',
        resourceId: TARGET_RESOURCE_ID,
      });

      const result = await resultPromise;
      expect(result!.correlationId).toBe('corr-8');
      expect(result!.error.message).toBe('Resource lookup failed');
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
      matcher = new Matcher(kb, eventBus, mockLogger);
      await matcher.initialize();
    });

    function makeContext(overrides: Partial<GatheredContext> = {}): GatheredContext {
      return {
        annotation: testAnnotation,
        sourceResource: testSourceResource,
        sourceContext: { before: '', selected: 'test', after: '' },
        ...overrides,
      };
    }

    it('should search with minimal context (sourceContext only)', async () => {
      mockSearchFn2.mockResolvedValue([RES_A]);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-no-ctx',
        context: { annotation: testAnnotation, sourceResource: testSourceResource, sourceContext: { selected: 'Alpha' } },
      });

      const result = await resultPromise;
      expect(result!.results).toHaveLength(1);
      expect(result!.results[0]).toMatchObject({ '@id': 'res-a', name: 'Alpha' });
      expect(result!.results[0]).toHaveProperty('score');
      expect(result!.results[0]).toHaveProperty('matchReason');
    });

    it('should score exact name match higher than contains match', async () => {
      mockSearchFn2.mockResolvedValue([RES_A, RES_B]);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-name',
        context: makeContext({ sourceContext: { before: '', selected: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
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

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-et',
        context: makeContext({
          sourceContext: { before: '', selected: 'nonmatching', after: '' }, // no name match — isolate entity type signal
          metadata: { entityTypes: ['Person', 'Author'] },
        }),
      });

      const result = await resultPromise;
      const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
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

    it('should boost bidirectional connections', async () => {
      // RES_A found via name, RES_B found via name — both match
      // RES_B is also a bidirectional connection
      mockSearchFn2.mockResolvedValue([RES_A, RES_B]);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-bidir',
        context: makeContext({
          sourceContext: { before: '', selected: 'test', after: '' },
          graphContext: {
            connections: [
              { resourceId: 'res-b', resourceName: 'Beta', bidirectional: true },
            ],
            citedByCount: 0,
          },
        }),
      });

      const result = await resultPromise;
      const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
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

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-neighbor',
        context: makeContext({
          sourceContext: { before: '', selected: 'something', after: '' },
          graphContext: {
            connections: [
              { resourceId: 'res-c', resourceName: 'Gamma', bidirectional: false },
            ],
            citedByCount: 0,
          },
        }),
      });

      const result = await resultPromise;
      expect(result!.results.length).toBeGreaterThanOrEqual(1);
      const gamma = result!.results.find((r: any) => r.name === 'Gamma');
      expect(gamma).toBeDefined();
    });

    it('should give multi-source bonus when candidate found by multiple strategies', async () => {
      // RES_A found by both name search and entity type search
      mockSearchFn2.mockResolvedValue([RES_A]);
      mockListResources.mockResolvedValue({ resources: [RES_A], total: 1 });

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-multi',
        context: makeContext({
          sourceContext: { before: '', selected: 'Alpha', after: '' },
          metadata: { entityTypes: ['Person'] },
        }),
      });

      const result = await resultPromise;
      const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
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

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-sort',
        context: makeContext({ sourceContext: { before: '', selected: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      const scores = result!.results as Array<{ score: number }>;
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
        generateText: vi.fn().mockResolvedValue('1. 0.9\n2. 0.2'),
        generateTextWithMetadata: vi.fn(),
      };
      matcher = new Matcher(kb, eventBus, mockLogger, mockInference);
      await matcher.initialize();

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-inference',
        context: makeContext({ sourceContext: { before: '', selected: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
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
        generateText: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
        generateTextWithMetadata: vi.fn(),
      };
      matcher = new Matcher(kb, eventBus, mockLogger, mockInference);
      await matcher.initialize();

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-inference-fail',
        context: makeContext({ sourceContext: { before: '', selected: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      // Should still return results with structural scores only
      expect(result!.results.length).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Inference semantic scoring failed, using structural scores only',
        expect.anything(),
      );
    });

    it('should not call inference when no inferenceClient provided', async () => {
      // Use the default matcher (no inference client)
      mockSearchFn2.mockResolvedValue([RES_A]);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-no-inference',
        context: makeContext({ sourceContext: { before: '', selected: 'Alpha', after: '' } }),
      });

      const result = await resultPromise;
      expect(result!.results.length).toBe(1);
      // No inference call — score is purely structural
      const alpha = result!.results[0] as any;
      expect(alpha.matchReason).not.toContain('semantic match');
    });

    it('should emit search-failed when context search throws', async () => {
      mockSearchFn2.mockRejectedValue(new Error('DB down'));

      const resultPromise = eventBus.get('bind:search-failed').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-fail',
        context: makeContext({ sourceContext: { before: '', selected: 'anything', after: '' } }),
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-fail');
      expect(result!.error.message).toBe('DB down');
    });

    describe('inference response parsing edge cases', () => {
      let mockInference: { generateText: ReturnType<typeof vi.fn>; generateTextWithMetadata: ReturnType<typeof vi.fn> };

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
          generateText: vi.fn(),
          generateTextWithMetadata: vi.fn(),
        };
        matcher = new Matcher(kb, eventBus, mockLogger, mockInference as InferenceClient);
        await matcher.initialize();
      });

      it('should drop scores outside 0-1 range', async () => {
        // Score > 1 should be ignored, score < 0 should be ignored
        mockInference.generateText.mockResolvedValue('1. 1.5\n2. -0.3\n3. 0.7');

        const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

        eventBus.get('bind:search-requested').next({
          referenceId: 'ref-range',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
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

        const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

        eventBus.get('bind:search-requested').next({
          referenceId: 'ref-malformed',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
        // Only Alpha (index 0) should get semantic match (0.8 > 0.5)
        const alpha = scores.find(r => r.name === 'Alpha');
        expect(alpha!.matchReason).toContain('semantic match');
        // Gamma (index 2, score 0.5) is not > 0.5
        const gamma = scores.find(r => r.name === 'Gamma');
        expect(gamma!.matchReason).not.toContain('semantic match');
      });

      it('should handle empty inference response', async () => {
        mockInference.generateText.mockResolvedValue('');

        const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

        eventBus.get('bind:search-requested').next({
          referenceId: 'ref-empty',
          context: makeContext({ sourceContext: { before: '', selected: 'Alpha', after: '' } }),
        });

        const result = await resultPromise;
        // Should still return results with structural scores only
        expect(result!.results.length).toBe(3);
        const alpha = result!.results.find((r: any) => r.name === 'Alpha') as any;
        expect(alpha.matchReason).not.toContain('semantic match');
      });

      it('should handle out-of-bounds indices', async () => {
        // Index 5 doesn't exist (only 3 candidates)
        mockInference.generateText.mockResolvedValue('1. 0.8\n5. 0.9\n3. 0.6');

        const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

        eventBus.get('bind:search-requested').next({
          referenceId: 'ref-oob',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
        // Alpha (index 0) should get boost, Gamma (index 2) should get boost
        // Index 4 (5th candidate) doesn't exist, should be silently ignored
        const alpha = scores.find(r => r.name === 'Alpha');
        expect(alpha!.matchReason).toContain('semantic match');
      });

      it('should not add semantic match reason when score is exactly 0.5', async () => {
        mockInference.generateText.mockResolvedValue('1. 0.5\n2. 0.51\n3. 0.49');

        const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

        eventBus.get('bind:search-requested').next({
          referenceId: 'ref-threshold',
          context: makeContext(),
        });

        const result = await resultPromise;
        const scores = result!.results as unknown as Array<{ name: string; score: number; matchReason: string }>;
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

        const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

        const summary = 'This passage discusses Greek mythology figures.';
        eventBus.get('bind:search-requested').next({
          referenceId: 'ref-summary',
          context: makeContext({
            sourceContext: { before: '', selected: 'Zeus', after: '' },
            graphContext: {
              connections: [
                { resourceId: 'r1', resourceName: 'Olympus', bidirectional: false },
              ],
              citedByCount: 0,
              inferredRelationshipSummary: summary,
            },
          }),
        });

        await resultPromise;
        const prompt = mockInference.generateText.mock.calls[0][0] as string;
        expect(prompt).toContain(summary);
        expect(prompt).toContain('Olympus');
      });

      it('should pass passage text and entity types to semantic scoring prompt', async () => {
        mockInference.generateText.mockResolvedValue('1. 0.5');

        const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

        eventBus.get('bind:search-requested').next({
          referenceId: 'ref-passage',
          context: makeContext({
            sourceContext: { before: 'In the beginning,', selected: 'Zeus ruled the heavens', after: 'and the earth.' },
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

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-4',
        context: { annotation: testAnnotation, sourceResource: testSourceResource, sourceContext: { selected: 'after stop' } },
      });

      // Give time for any processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockSearchFn).not.toHaveBeenCalled();
    });
  });
});
