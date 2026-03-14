/**
 * Binder Actor Tests
 *
 * Tests the Binder's RxJS pipeline:
 * - Search request handling (bind:search-requested → bind:search-results/bind:search-failed)
 * - Referenced-by handling (bind:referenced-by-requested → bind:referenced-by-result/bind:referenced-by-failed)
 * - Error handling
 * - Lifecycle (stop)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, resourceId, type Logger, type ResourceId } from '@semiont/core';
import type { KnowledgeBase } from '../knowledge-base';
import { Binder } from '../binder';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

interface MockGraphOverrides {
  searchResources?: (...args: any[]) => any;
  getResourceReferencedBy?: (...args: any[]) => any;
  getResource?: (...args: any[]) => any;
}

function createMockKb(overrides: MockGraphOverrides = {}): KnowledgeBase {
  return {
    eventStore: {} as any,
    views: {} as any,
    content: {} as any,
    graph: {
      searchResources: overrides.searchResources ?? vi.fn(),
      getResourceReferencedBy: overrides.getResourceReferencedBy ?? vi.fn(),
      getResource: overrides.getResource ?? vi.fn(),
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

describe('Binder', () => {
  let eventBus: EventBus;
  let binder: Binder;
  let mockSearchFn: ReturnType<typeof vi.fn>;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    mockSearchFn = vi.fn();
    kb = createMockKb({ searchResources: mockSearchFn });
    binder = new Binder(kb, eventBus, mockLogger);
    await binder.initialize();
  });

  afterEach(async () => {
    await binder.stop();
    eventBus.destroy();
  });

  describe('search handling', () => {
    it('should emit bind:search-results on success', async () => {
      const mockResults = [
        { '@id': 'http://localhost:4000/resources/r1', name: 'Resource 1' },
        { '@id': 'http://localhost:4000/resources/r2', name: 'Resource 2' },
      ];
      mockSearchFn.mockResolvedValue(mockResults);

      const resultPromise = eventBus.get('bind:search-results').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-1',
        searchTerm: 'test query',
      });

      const result = await resultPromise;
      expect(result!.referenceId).toBe('ref-1');
      expect(result!.searchTerm).toBe('test query');
      expect(result!.results).toEqual(mockResults);

      expect(mockSearchFn).toHaveBeenCalledWith('test query');
    });

    it('should emit bind:search-failed on error', async () => {
      mockSearchFn.mockRejectedValue(new Error('Graph connection failed'));

      const resultPromise = eventBus.get('bind:search-failed').pipe(take(1)).toPromise();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-2',
        searchTerm: 'failing query',
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
        searchTerm: 'nonexistent',
      });

      const result = await resultPromise;
      expect(result!.results).toEqual([]);
    });
  });

  describe('referenced-by handling', () => {
    const DOC_A_URI = 'http://localhost:4000/resources/doc-a';
    const DOC_B_URI = 'http://localhost:4000/resources/doc-b';
    const TARGET_RESOURCE_ID = resourceId('target-res');

    let mockReferencedBy: ReturnType<typeof vi.fn>;
    let mockGetResource: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      // Stop the binder created in outer beforeEach (uses search-only KB)
      await binder.stop();
      eventBus.destroy();

      vi.clearAllMocks();
      eventBus = new EventBus();
      mockReferencedBy = vi.fn();
      mockGetResource = vi.fn();
      kb = createMockKb({
        getResourceReferencedBy: mockReferencedBy,
        getResource: mockGetResource,
      });
      binder = new Binder(kb, eventBus, mockLogger);
      await binder.initialize();
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

  describe('lifecycle', () => {
    it('should stop cleanly', async () => {
      await binder.stop();
      expect(mockLogger.info).toHaveBeenCalledWith('Binder actor stopped');
    });

    it('should not process events after stop', async () => {
      await binder.stop();

      eventBus.get('bind:search-requested').next({
        referenceId: 'ref-4',
        searchTerm: 'after stop',
      });

      // Give time for any processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockSearchFn).not.toHaveBeenCalled();
    });
  });
});
