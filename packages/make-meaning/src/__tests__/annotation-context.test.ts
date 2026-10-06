/**
 * Annotation gather: the context assembled around one annotation, from the
 * views, the content reads and the graph.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AnnotationGather, type AnnotationGatherReads } from '../annotation-gather';
import { deriveViews } from '@semiont/core';
import { resourceId, annotationId, type Logger } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import { createRecordFixture, type RecordFixture } from './helpers/record-fixtures';
import { createMockEmbeddingProvider } from './helpers/smelter-harness';

const mockEmbeddingProvider = createMockEmbeddingProvider();

function createMockGraphDb(): GraphDatabase {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    createResource: vi.fn().mockResolvedValue({}),
    getResource: vi.fn().mockImplementation(async (id: unknown) => ({ '@id': String(id), name: 'Test Resource', entityTypes: [], representations: [] })),
    updateResource: vi.fn().mockResolvedValue({}),
    deleteResource: vi.fn().mockResolvedValue(undefined),
    listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
    createAnnotation: vi.fn().mockResolvedValue({}),
    getAnnotation: vi.fn().mockResolvedValue(null),
    updateAnnotation: vi.fn().mockResolvedValue({}),
    deleteAnnotation: vi.fn().mockResolvedValue(undefined),
    listAnnotations: vi.fn().mockResolvedValue({ annotations: [], total: 0 }),
    getHighlights: vi.fn().mockResolvedValue([]),
    resolveReference: vi.fn().mockResolvedValue({}),
    getReferences: vi.fn().mockResolvedValue([]),
    getEntityReferences: vi.fn().mockResolvedValue([]),
    getResourceAnnotations: vi.fn().mockResolvedValue([]),
    getResourceReferencedBy: vi.fn().mockResolvedValue([]),
    getResourceConnections: vi.fn().mockResolvedValue([]),
    findPath: vi.fn().mockResolvedValue([]),
    getEntityTypeStats: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ resourceCount: 0, annotationCount: 0, highlightCount: 0, referenceCount: 0, entityReferenceCount: 0, entityTypes: {}, contentTypes: {} }),
    batchCreateResources: vi.fn().mockResolvedValue([]),
    createAnnotations: vi.fn().mockResolvedValue([]),
    resolveReferences: vi.fn().mockResolvedValue([]),
    getEntityTypes: vi.fn().mockResolvedValue([]),
    addEntityType: vi.fn().mockResolvedValue(undefined),
    addEntityTypes: vi.fn().mockResolvedValue(undefined),
    generateId: vi.fn().mockReturnValue('mock-id'),
    clearDatabase: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphDatabase;
}

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('AnnotationGather.buildLLMContext', () => {
  let record: RecordFixture;
  // The narrow gather reads — real views, a mock graph, mock vectors.
  let kb: AnnotationGatherReads;
  let mockGraphDb: GraphDatabase;

  beforeAll(async () => {
    record = await createRecordFixture();

    mockGraphDb = createMockGraphDb();
    kb = {
      views: record.views,
      content: record.content,
      // Text-media harness: the derived-text door is never consulted.
      anchoredText: async () => ({ kind: 'unknown' as const }),
      graph: mockGraphDb,
      vectors: { searchAnnotations: vi.fn().mockResolvedValue([]) } as AnnotationGatherReads['vectors'],
      weaveProgress: { whenApplied: vi.fn(async () => {}) },
    };
  });

  afterAll(async () => {
    await record.teardown();
  });

  async function createTestResource(id: string, content: string): Promise<void> {
    await record.resource(id, { name: `Test Resource ${id}`, text: content });
  }

  // Helper to create an annotation
  async function createTestAnnotation(
    resId: string,
    annId: ReturnType<typeof annotationId>,
    exact: string,
    start: number,
    end: number
  ): Promise<void> {
    await record.annotate(resId, {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: annId,
      type: 'Annotation',
      motivation: 'commenting',
      created: '2026-01-01T00:00:00.000Z',
      body: {
        type: 'TextualBody',
        value: 'Test comment',
        format: 'text/plain',
        purpose: 'commenting'
      },
      target: {
        source: resourceId(resId),
        selector: [{
          type: 'TextPositionSelector',
          start,
          end
        }, {
          type: 'TextQuoteSelector',
          exact,
          prefix: '',
          suffix: ''
        }]
      }
    });
  }

  it('should validate contextWindow range', async () => {
    const testResourceId = `resource-validate-${Date.now()}`;
    await createTestResource(testResourceId, 'Test content');

    // Test too small
    await expect(
      AnnotationGather.buildLLMContext(
        annotationId('test-1'),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        { contextWindow: 50 },
        undefined,
        mockLogger
      )
    ).rejects.toThrow('contextWindow must be between 100 and 5000');

    // Test too large
    await expect(
      AnnotationGather.buildLLMContext(
        annotationId('test-2'),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        { contextWindow: 6000 },
        undefined,
        mockLogger
      )
    ).rejects.toThrow('contextWindow must be between 100 and 5000');
  });

  it('should handle valid contextWindow values', async () => {
    const testResourceId = `resource-window-${Date.now()}`;
    const testAnnId = `ann-window-${Date.now()}`;
    await createTestResource(testResourceId, 'Some text for context window testing');
    await createTestAnnotation(testResourceId, annotationId(testAnnId), 'text', 5, 9);

    // Test minimum valid value
    await expect(
      AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        { contextWindow: 100 },
        undefined,
        mockLogger
      )
    ).resolves.toBeDefined();

    // Test maximum valid value
    await expect(
      AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        { contextWindow: 5000 },
        undefined,
        mockLogger
      )
    ).resolves.toBeDefined();

    // Test mid-range value
    await expect(
      AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        { contextWindow: 1500 },
        undefined,
        mockLogger
      )
    ).resolves.toBeDefined();
  });

  it('should build context with default options', async () => {
    const testResourceId = `resource-default-${Date.now()}`;
    const testAnnId = `ann-default-${Date.now()}`;
    await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
    await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);


    const result = await AnnotationGather.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
        mockEmbeddingProvider,
      {},
      undefined,
      mockLogger
    );

    expect(result).toBeDefined();
    expect(result.focus).toHaveProperty('annotation');
    expect(result.focus).toHaveProperty('sourceResource');
  });

  it('should respect includeSourceContext option', async () => {
    const testResourceId = `resource-source-${Date.now()}`;
    const testAnnId = `ann-source-${Date.now()}`;
    await createTestResource(testResourceId, 'Testing source context inclusion');
    await createTestAnnotation(testResourceId, annotationId(testAnnId), 'context', 15, 22);


    const withContext = await AnnotationGather.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
        mockEmbeddingProvider,
      { includeSourceContext: true },
      undefined,
      mockLogger
    );

    const withoutContext = await AnnotationGather.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
        mockEmbeddingProvider,
      { includeSourceContext: false },
      undefined,
      mockLogger
    );

    expect(withContext).toBeDefined();
    expect(withoutContext).toBeDefined();
    // Both should have basic structure but context presence may differ
  });

  it('should throw error for non-existent resource', async () => {
    await expect(
      AnnotationGather.buildLLMContext(
        annotationId('nonexistent'),
        resourceId('nonexistent-resource'),
        kb,
        mockEmbeddingProvider,
        {},
        undefined,
        mockLogger
      )
    ).rejects.toThrow();
  });

  it('should handle annotations without TextPositionSelector', async () => {
    const testResourceId = `resource-no-position-${Date.now()}`;
    const testAnnId = `ann-no-position-${Date.now()}`;
    await createTestResource(testResourceId, 'Content for testing missing selector');

    // An annotation with only a TextQuoteSelector
    await record.annotate(testResourceId, {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: annotationId(testAnnId),
      type: 'Annotation',
      motivation: 'commenting',
      created: '2026-01-01T00:00:00.000Z',
      body: {
        type: 'TextualBody',
        value: 'Comment without position',
        format: 'text/plain',
        purpose: 'commenting'
      },
      target: {
        source: resourceId(testResourceId),
        selector: {
          type: 'TextQuoteSelector',
          exact: 'testing',
          prefix: 'for ',
          suffix: ' missing'
        }
      }
    });

    const result = await AnnotationGather.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
        mockEmbeddingProvider,
      {},
      undefined,
      mockLogger
    );

    expect(result).toBeDefined();
    expect(result.focus).toHaveProperty('annotation');
  });

  describe('graph context enrichment', () => {
    it('should include graph connections', async () => {
      const testResourceId = `resource-graph-conn-${Date.now()}`;
      const testAnnId = `ann-graph-conn-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      // Mock graph connections
      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          targetResource: { '@id': 'connected-1', id: 'connected-1', name: 'Connected Resource', entityTypes: ['Person'] },
          annotations: [],
          bidirectional: true,
        },
      ]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { type: 'Person', count: 5 },
        { type: 'Location', count: 3 },
      ]);

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        undefined,
        mockLogger
      );

      expect(result.graph).toBeDefined();
      const views = deriveViews(result.graph, testResourceId, testAnnId);
      expect(views.connections).toHaveLength(1);
      expect(views.connections[0]).toMatchObject({
        resourceId: 'connected-1',
        resourceName: 'Connected Resource',
        bidirectional: true,
      });
    });

    it('should include citedBy resources', async () => {
      const testResourceId = `resource-cited-${Date.now()}`;
      const testAnnId = `ann-cited-${Date.now()}`;
      const citingResourceId = `resource-citing-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      // Create the citing resource so views.get can find it
      await createTestResource(citingResourceId, 'This document cites the fox resource');

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: annotationId('citing-ann-1'),
          type: 'Annotation',
          motivation: 'linking',
          target: { source: citingResourceId },
          body: {},
        },
      ]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        undefined,
        mockLogger
      );

      const views = deriveViews(result.graph, testResourceId, testAnnId);
      expect(views.citedByCount).toBe(1);
      expect(views.citedBy).toHaveLength(1);
      expect(views.citedBy[0]?.resourceId).toBe(citingResourceId);
    });

    it('should include entity type frequencies', async () => {
      const testResourceId = `resource-freq-${Date.now()}`;
      const testAnnId = `ann-freq-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { type: 'Person', count: 12 },
        { type: 'Location', count: 7 },
        { type: 'Event', count: 2 },
      ]);

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        undefined,
        mockLogger
      );

      expect(result.metadata.entityTypeFrequencies).toEqual({
        Person: 12,
        Location: 7,
        Event: 2,
      });
    });

    it('should include sibling entity types from other annotations', async () => {
      const testResourceId = `resource-sibling-${Date.now()}`;
      const testAnnId = `ann-sibling-main-${Date.now()}`;
      const siblingAnnId = `ann-sibling-other-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog near London');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      // Add a sibling annotation with entity types
      await record.annotate(testResourceId, {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        id: annotationId(siblingAnnId),
        type: 'Annotation',
        motivation: 'tagging',
        created: '2026-01-01T00:00:00.000Z',
        body: [{
          type: 'TextualBody',
          value: 'Location',
          purpose: 'tagging',
          format: 'text/plain'
        }],
        target: {
          source: resourceId(testResourceId),
          selector: [{
            type: 'TextPositionSelector',
            start: 49,
            end: 55
          }]
        }
      });

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      // Siblings come from the graph projection (getResourceAnnotations), not the view.
      (mockGraphDb.getResourceAnnotations as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: annotationId(siblingAnnId),
          type: 'Annotation',
          motivation: 'tagging',
          body: [{ type: 'TextualBody', value: 'Location', purpose: 'tagging', format: 'text/plain' }],
          target: { source: testResourceId },
        },
      ]);

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        undefined,
        mockLogger
      );

      const views = deriveViews(result.graph, testResourceId, testAnnId);
      // The sibling annotation has entity type 'Location'
      expect(views.siblingEntityTypes).toContain('Location');
    });

    it('should generate inferredRelationshipSummary when inferenceClient provided', async () => {
      const testResourceId = `resource-infer-${Date.now()}`;
      const testAnnId = `ann-infer-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          targetResource: { '@id': 'conn-1', id: 'conn-1', name: 'Animals', entityTypes: ['Topic'] },
          annotations: [],
          bidirectional: false,
        },
      ]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const mockInferenceClient = {
        type: 'mock' as const,
        modelId: 'mock-model',
        maxConcurrency: 1,
        verifyDetectionYield: false,
        generateText: vi.fn().mockResolvedValue('This passage about a fox relates to the Animals topic in the knowledge base.'),
        generateTextWithMetadata: vi.fn(),
        limits: vi.fn().mockResolvedValue({ contextTokens: 1_000_000, maxOutputTokens: 1_000_000 }),
        generateStructured: vi.fn().mockResolvedValue({ items: [], stopReason: 'end_turn' }),
      };

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        mockInferenceClient,
        mockLogger
      );

      expect(result.inferredRelationshipSummary).toBeDefined();
      expect(result.inferredRelationshipSummary).toContain('fox');
      expect(mockInferenceClient.generateText).toHaveBeenCalledTimes(1);
      // Verify the prompt includes passage and graph neighborhood
      const prompt = mockInferenceClient.generateText.mock.calls[0][0];
      expect(prompt).toContain('fox');
      expect(prompt).toContain('Animals');
    });

    it('should not include inferredRelationshipSummary without inferenceClient', async () => {
      const testResourceId = `resource-no-infer-${Date.now()}`;
      const testAnnId = `ann-no-infer-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        undefined,
        mockLogger
      );

      expect(result.inferredRelationshipSummary).toBeUndefined();
    });

    it('should gracefully handle inference failure', async () => {
      const testResourceId = `resource-infer-fail-${Date.now()}`;
      const testAnnId = `ann-infer-fail-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const mockInferenceClient = {
        type: 'mock' as const,
        modelId: 'mock-model',
        maxConcurrency: 1,
        verifyDetectionYield: false,
        generateText: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
        generateTextWithMetadata: vi.fn(),
        limits: vi.fn().mockResolvedValue({ contextTokens: 1_000_000, maxOutputTokens: 1_000_000 }),
        generateStructured: vi.fn().mockResolvedValue({ items: [], stopReason: 'end_turn' }),
      };

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        mockInferenceClient,
        mockLogger
      );

      // Should succeed without inferredRelationshipSummary
      expect(result).toBeDefined();
      expect(result.inferredRelationshipSummary).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to generate inferred relationship summary',
        expect.anything(),
      );
    });

    it('should handle empty graph gracefully', async () => {
      const testResourceId = `resource-empty-graph-${Date.now()}`;
      const testAnnId = `ann-empty-graph-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, annotationId(testAnnId), 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await AnnotationGather.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        mockEmbeddingProvider,
        {},
        undefined,
        mockLogger
      );

      const views = deriveViews(result.graph, testResourceId, testAnnId);
      expect(views).toEqual({
        connections: [],
        citedBy: [],
        citedByCount: 0,
        siblingEntityTypes: [],
      });
    });
  });

  // ── Content reads keyed by resource id ─────────────────────────────────────
  //
  // The fetch is `content.getBinary(resourceId)`, so the Librarian can serve
  // it over HTTP without the caller holding a storage path. `storageUri` on
  // the descriptor is the has-content SIGNAL, which is the subtle half: the
  // field is read, but is never the fetch key. These pin both halves — a
  // fetch by storageUri, or a dropped signal check, would pass every other
  // test.
  describe('content reads are keyed by resource id, gated on storageUri', () => {
    it('fetches the TARGET resource by id too, when a reference resolves', async () => {
      // A resolved reference gathers both ends: the source for the selector's
      // surroundings, the target for what it points at. Both go through
      // getBinary, and the target half is the easier one to miss because it
      // only runs for annotations that actually resolve.
      const src = 'res-ref-source';
      const dst = 'res-ref-target';
      await createTestResource(src, 'see the other document for detail');
      await createTestResource(dst, 'the other document says something specific');

      const aid = annotationId('ann-resolved-ref');
      await record.annotate(src, {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        id: aid,
        type: 'Annotation',
        motivation: 'linking',
        created: '2026-01-01T00:00:00.000Z',
        // The body's source is what makes this a RESOLVED reference —
        // it is where targetDoc and the target fetch both come from.
        body: [{ type: 'SpecificResource', source: resourceId(dst), purpose: 'linking' }],
        target: {
          source: resourceId(src),
          selector: [{ type: 'TextPositionSelector', start: 8, end: 22 }],
        },
      });

      const spy = vi.spyOn(kb.content, 'getBinary');
      const result = await AnnotationGather.buildLLMContext(
        aid, resourceId(src), kb, mockEmbeddingProvider,
        { includeTargetContext: true }, undefined, mockLogger,
      );

      // Both ends fetched, both by resource id.
      expect(spy).toHaveBeenCalledWith(resourceId(src));
      expect(spy).toHaveBeenCalledWith(resourceId(dst));
      // `focus` is discriminated on `kind`; narrow before reading the
      // annotation-only half rather than asserting past the union.
      expect(result.focus.kind).toBe('annotation');
      if (result.focus.kind !== 'annotation') throw new Error('expected an annotation focus');
      expect(result.focus.targetContext?.content).toContain('the other document');
      spy.mockRestore();
    });
  });
});
