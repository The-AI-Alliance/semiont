/**
 * Annotation Context Tests
 *
 * Tests the AnnotationContext class which assembles annotation context
 * from view storage and content store.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AnnotationContext, type AnnotationGatherReads } from '../annotation-context';
import { deriveViews } from '@semiont/core';
import { resourceId, annotationId, userId, EventBus, type Logger } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore } from '@semiont/content';
import type { GraphDatabase } from '@semiont/graph';
import { workingTreeContentReads } from '../knowledge-base';
import { createTestProject } from './helpers/test-project';
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
    detectAnnotations: vi.fn().mockResolvedValue([]),
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

describe('AnnotationContext', () => {
  let project: Awaited<ReturnType<typeof createTestProject>>['project'];
  let teardown: () => Promise<void>;
  // The narrow gather reads — real views + the real working-tree content
  // adapter (exercised here, not mocked), a mock graph, mock vectors.
  let kb: AnnotationGatherReads;
  let workingTree: WorkingTreeStore;
  let mockGraphDb: GraphDatabase;

  beforeAll(async () => {
    ({ project, teardown } = await createTestProject('annotation-context'));

    mockGraphDb = createMockGraphDb();
    const eventStore = createEventStore(project, new EventBus(), mockLogger);
    workingTree = new WorkingTreeStore(project, mockLogger);
    kb = {
      views: eventStore.viewStorage,
      content: workingTreeContentReads(eventStore.viewStorage, workingTree),
      graph: mockGraphDb,
      vectors: { searchAnnotations: vi.fn().mockResolvedValue([]) } as AnnotationGatherReads['vectors'],
      weaveProgress: { whenApplied: vi.fn(async () => {}) },
    };
  });

  afterAll(async () => {
    await teardown();
  });

  // Helper to create a test resource
  async function createTestResource(id: string, content: string): Promise<void> {
    const testContent = Buffer.from(content, 'utf-8');
    const storageUri = `file://test-resources/${id}.txt`;
    const { checksum } = await workingTree.store(testContent, storageUri);

    const eventStore = createEventStore(project, new EventBus(), mockLogger);

    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: resourceId(id),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: `Test Resource ${id}`,
        format: 'text/plain',
        contentChecksum: checksum,
        storageUri,
      }
    });

    // Wait for view to materialize
    let attempts = 0;
    while (attempts < 10) {
      try {
        const view = await kb.views.get(resourceId(id));
        if (view) break;
      } catch (e) {
        // View not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
  }

  // Helper to create an annotation
  async function createTestAnnotation(
    resId: string,
    annId: ReturnType<typeof annotationId>,
    exact: string,
    start: number,
    end: number
  ): Promise<void> {
    const eventStore = createEventStore(project, new EventBus(), mockLogger);

    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: resourceId(resId),
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: annId,
          type: 'Annotation',
          motivation: 'commenting',
          body: {
            type: 'TextualBody',
            value: 'Test comment',
            format: 'text/plain',
            purpose: 'commenting'
          },
          target: {
            source: resId,
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
        }
      }
    });

    // Wait for view to update
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  it('should validate contextWindow range', async () => {
    const testResourceId = `resource-validate-${Date.now()}`;
    await createTestResource(testResourceId, 'Test content');

    // Test too small
    await expect(
      AnnotationContext.buildLLMContext(
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
      AnnotationContext.buildLLMContext(
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
      AnnotationContext.buildLLMContext(
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
      AnnotationContext.buildLLMContext(
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
      AnnotationContext.buildLLMContext(
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


    const result = await AnnotationContext.buildLLMContext(
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


    const withContext = await AnnotationContext.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
        mockEmbeddingProvider,
      { includeSourceContext: true },
      undefined,
      mockLogger
    );

    const withoutContext = await AnnotationContext.buildLLMContext(
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
      AnnotationContext.buildLLMContext(
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

    const eventStore = createEventStore(project, new EventBus(), mockLogger);

    // Create annotation with only TextQuoteSelector
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: annotationId(testAnnId),
          type: 'Annotation',
          motivation: 'commenting',
          body: {
            type: 'TextualBody',
            value: 'Comment without position',
            format: 'text/plain',
            purpose: 'commenting'
          },
          target: {
            source: testResourceId,
            selector: {
              type: 'TextQuoteSelector',
              exact: 'testing',
              prefix: 'for ',
              suffix: ' missing'
            }
          }
        }
      }
    });

    await new Promise(resolve => setTimeout(resolve, 100));


    const result = await AnnotationContext.buildLLMContext(
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

      const result = await AnnotationContext.buildLLMContext(
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

      const result = await AnnotationContext.buildLLMContext(
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

      const result = await AnnotationContext.buildLLMContext(
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
      const eventStore = createEventStore(project, new EventBus(), mockLogger);
      await eventStore.appendEvent({
        type: 'mark:added',
        resourceId: resourceId(testResourceId),
        userId: userId('user-1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            id: annotationId(siblingAnnId),
            type: 'Annotation',
            motivation: 'tagging',
            body: [{
              type: 'TextualBody',
              value: 'Location',
              purpose: 'tagging',
              format: 'text/plain'
            }],
            target: {
              source: testResourceId,
              selector: [{
                type: 'TextPositionSelector',
                start: 49,
                end: 55
              }]
            }
          }
        }
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      // Siblings now come from the graph projection (getResourceAnnotations), not the view (Q1=A / (c)).
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

      const result = await AnnotationContext.buildLLMContext(
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
        generateText: vi.fn().mockResolvedValue('This passage about a fox relates to the Animals topic in the knowledge base.'),
        generateTextWithMetadata: vi.fn(),
        limits: vi.fn().mockResolvedValue({ contextTokens: 1_000_000, maxOutputTokens: 1_000_000 }),
        generateStructured: vi.fn().mockResolvedValue({ items: [], stopReason: 'end_turn' }),
      };

      const result = await AnnotationContext.buildLLMContext(
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

      const result = await AnnotationContext.buildLLMContext(
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
        generateText: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
        generateTextWithMetadata: vi.fn(),
        limits: vi.fn().mockResolvedValue({ contextTokens: 1_000_000, maxOutputTokens: 1_000_000 }),
        generateStructured: vi.fn().mockResolvedValue({ items: [], stopReason: 'end_turn' }),
      };

      const result = await AnnotationContext.buildLLMContext(
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

      const result = await AnnotationContext.buildLLMContext(
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

  // ── The resource-id content re-key (EXTRACT-LIBRARIAN P2 / D-CONTENT b) ────
  //
  // The fetch moved from `content.retrieve(storageUri)` to
  // `content.getBinary(resourceId)`, so the Librarian can serve it over HTTP
  // without the caller holding a storage path. `storageUri` stays on the
  // descriptor as the has-content SIGNAL, which is the subtle half: the field
  // is still read, just no longer used to fetch. These pin both halves — a
  // regression that fetched by storageUri again, or dropped the signal check,
  // would otherwise pass every existing test.
  describe('content reads are keyed by resource id, gated on storageUri', () => {
    it('getAnnotationContext reads the resource through getBinary', async () => {
      const rid = 'res-content-by-id';
      const aid = annotationId('ann-content-by-id');
      await createTestResource(rid, 'alpha bravo charlie delta echo');
      await createTestAnnotation(rid, aid, 'charlie', 12, 19);

      const spy = vi.spyOn(kb.content, 'getBinary');
      const result = await AnnotationContext.getAnnotationContext(
        aid, resourceId(rid), 5, 5, kb,
      );

      // Keyed by the resource id, never by the storage path.
      expect(spy).toHaveBeenCalledWith(resourceId(rid));
      expect(result.context.selected).toBe('charlie');
      spy.mockRestore();
    });

    it('refuses a resource whose descriptor carries no storageUri', async () => {
      // The signal, not the key: a descriptor without it has no content to
      // fetch, and the refusal has to happen before a getBinary that would
      // fail further away with a less useful message.
      const bare = { '@id': resourceId('res-no-content'), name: 'No content', representations: [] };
      await expect(
        AnnotationContext.getAnnotationContext(
          annotationId('ann-x'), resourceId('res-no-content'), 5, 5,
          { views: { get: vi.fn().mockResolvedValue({ resource: bare, annotations: { annotations: [] } }) } } as never,
        ),
      ).rejects.toThrow();
    });

    it('fetches the TARGET resource by id too, when a reference resolves', async () => {
      // A resolved reference gathers both ends: the source for the selector's
      // surroundings, the target for what it points at. Both go through
      // getBinary now, and the target half is the easier one to leave behind
      // because it only runs for annotations that actually resolve.
      const src = 'res-ref-source';
      const dst = 'res-ref-target';
      await createTestResource(src, 'see the other document for detail');
      await createTestResource(dst, 'the other document says something specific');

      const aid = annotationId('ann-resolved-ref');
      const eventStore = createEventStore(project, new EventBus(), mockLogger);
      await eventStore.appendEvent({
        type: 'mark:added',
        resourceId: resourceId(src),
        userId: userId('user-1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            id: aid,
            type: 'Annotation',
            motivation: 'linking',
            // The body's source is what makes this a RESOLVED reference —
            // it is where targetDoc and the target fetch both come from.
            body: [{ type: 'SpecificResource', source: dst, purpose: 'linking' }],
            target: {
              source: src,
              selector: [{ type: 'TextPositionSelector', start: 8, end: 22 }],
            },
          },
        },
      } as never);
      await new Promise((r) => setTimeout(r, 100));

      const spy = vi.spyOn(kb.content, 'getBinary');
      const result = await AnnotationContext.buildLLMContext(
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

  // ── The working-tree adapter's own refusal (knowledge-base.ts) ─────────────
  describe('workingTreeContentReads', () => {
    it('names the resource when it has no storageUri', async () => {
      // In-process roots satisfy ContentReads with this adapter; the Librarian
      // satisfies it with HttpContentTransport. Both must fail the same way,
      // so this message is part of the seam's contract, not an internal detail.
      const reads = workingTreeContentReads(
        { get: vi.fn().mockResolvedValue({ resource: { '@id': 'res-empty', name: 'x', representations: [] } }) } as never,
        workingTree,
      );
      await expect(reads.getBinary(resourceId('res-empty')))
        .rejects.toThrow(/no storageUri for res-empty/);
    });

    it('reports a resource the views do not know', async () => {
      const reads = workingTreeContentReads(
        { get: vi.fn().mockResolvedValue(undefined) } as never,
        workingTree,
      );
      await expect(reads.getBinary(resourceId('res-absent'))).rejects.toThrow(/res-absent/);
    });
  });
});
