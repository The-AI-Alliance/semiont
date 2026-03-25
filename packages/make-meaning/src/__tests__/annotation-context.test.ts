/**
 * Annotation Context Tests
 *
 * Tests the AnnotationContext class which assembles annotation context
 * from view storage and content store.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AnnotationContext } from '../annotation-context';
import { resourceId, annotationId, userId, type Logger } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore } from '@semiont/content';
import type { GraphDatabase } from '@semiont/graph';
import type { KnowledgeBase } from '../knowledge-base';
import { createTestProject } from './helpers/test-project';

function createMockGraphDb(): GraphDatabase {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    createResource: vi.fn().mockResolvedValue({}),
    getResource: vi.fn().mockResolvedValue(null),
    updateResource: vi.fn().mockResolvedValue({}),
    deleteResource: vi.fn().mockResolvedValue(undefined),
    listResources: vi.fn().mockResolvedValue({ resources: [], total: 0 }),
    searchResources: vi.fn().mockResolvedValue([]),
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
  let kb: KnowledgeBase;
  let mockGraphDb: GraphDatabase;

  beforeAll(async () => {
    ({ project, teardown } = await createTestProject('annotation-context'));

    mockGraphDb = createMockGraphDb();
    const eventStore = createEventStore(project, undefined, mockLogger);
    kb = {
      eventStore,
      views: eventStore.viewStorage,
      content: new WorkingTreeStore(project, mockLogger),
      graph: mockGraphDb,
      projectionsDir: project.projectionsDir,
    };
  });

  afterAll(async () => {
    await teardown();
  });

  // Helper to create a test resource
  async function createTestResource(id: string, content: string): Promise<void> {
    const testContent = Buffer.from(content, 'utf-8');
    const storageUri = `file://test-resources/${id}.txt`;
    const { checksum } = await kb.content.store(testContent, storageUri);

    const eventStore = createEventStore(project, undefined, mockLogger);

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId(id),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: `Test Resource ${id}`,
        format: 'text/plain',
        contentChecksum: checksum,
        storageUri,
        creationMethod: 'api'
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
    annId: string,
    exact: string,
    start: number,
    end: number
  ): Promise<void> {
    const eventStore = createEventStore(project, undefined, mockLogger);

    await eventStore.appendEvent({
      type: 'annotation.added',
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
    await createTestAnnotation(testResourceId, testAnnId, 'text', 5, 9);

    // Test minimum valid value
    await expect(
      AnnotationContext.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
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
    await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);


    const result = await AnnotationContext.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
      {},
      undefined,
      mockLogger
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty('annotation');
    expect(result).toHaveProperty('sourceResource');
  });

  it('should respect includeSourceContext option', async () => {
    const testResourceId = `resource-source-${Date.now()}`;
    const testAnnId = `ann-source-${Date.now()}`;
    await createTestResource(testResourceId, 'Testing source context inclusion');
    await createTestAnnotation(testResourceId, testAnnId, 'context', 15, 22);


    const withContext = await AnnotationContext.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
      { includeSourceContext: true },
      undefined,
      mockLogger
    );

    const withoutContext = await AnnotationContext.buildLLMContext(
      annotationId(testAnnId),
      resourceId(testResourceId),
      kb,
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

    const eventStore = createEventStore(project, undefined, mockLogger);

    // Create annotation with only TextQuoteSelector
    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: testAnnId,
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
      {},
      undefined,
      mockLogger
    );

    expect(result).toBeDefined();
    expect(result.annotation).toBeDefined();
  });

  describe('graph context enrichment', () => {
    it('should include graphContext with connections', async () => {
      const testResourceId = `resource-graph-conn-${Date.now()}`;
      const testAnnId = `ann-graph-conn-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

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
        {},
        undefined,
        mockLogger
      );

      expect(result.context).toBeDefined();
      expect(result.context?.graphContext).toBeDefined();
      expect(result.context?.graphContext?.connections).toHaveLength(1);
      expect(result.context?.graphContext?.connections?.[0]).toMatchObject({
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
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

      // Create the citing resource so views.get can find it
      await createTestResource(citingResourceId, 'This document cites the fox resource');

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'citing-ann-1',
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
        {},
        undefined,
        mockLogger
      );

      expect(result.context?.graphContext?.citedByCount).toBe(1);
      expect(result.context?.graphContext?.citedBy).toHaveLength(1);
      expect(result.context?.graphContext?.citedBy?.[0]?.resourceId).toBe(citingResourceId);
    });

    it('should include entity type frequencies', async () => {
      const testResourceId = `resource-freq-${Date.now()}`;
      const testAnnId = `ann-freq-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

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
        {},
        undefined,
        mockLogger
      );

      expect(result.context?.graphContext?.entityTypeFrequencies).toEqual({
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
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

      // Add a sibling annotation with entity types
      const eventStore = createEventStore(project, undefined, mockLogger);
      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: resourceId(testResourceId),
        userId: userId('user-1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            id: siblingAnnId,
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

      const result = await AnnotationContext.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        {},
        undefined,
        mockLogger
      );

      expect(result.context?.graphContext?.siblingEntityTypes).toBeDefined();
      // The sibling annotation has entity type 'Location'
      expect(result.context?.graphContext?.siblingEntityTypes).toContain('Location');
    });

    it('should generate inferredRelationshipSummary when inferenceClient provided', async () => {
      const testResourceId = `resource-infer-${Date.now()}`;
      const testAnnId = `ann-infer-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

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
        generateText: vi.fn().mockResolvedValue('This passage about a fox relates to the Animals topic in the knowledge base.'),
        generateTextWithMetadata: vi.fn(),
      };

      const result = await AnnotationContext.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        {},
        mockInferenceClient,
        mockLogger
      );

      expect(result.context?.graphContext?.inferredRelationshipSummary).toBeDefined();
      expect(result.context?.graphContext?.inferredRelationshipSummary).toContain('fox');
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
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await AnnotationContext.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        {},
        undefined,
        mockLogger
      );

      expect(result.context?.graphContext?.inferredRelationshipSummary).toBeUndefined();
    });

    it('should gracefully handle inference failure', async () => {
      const testResourceId = `resource-infer-fail-${Date.now()}`;
      const testAnnId = `ann-infer-fail-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const mockInferenceClient = {
        generateText: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
        generateTextWithMetadata: vi.fn(),
      };

      const result = await AnnotationContext.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        {},
        mockInferenceClient,
        mockLogger
      );

      // Should succeed without inferredRelationshipSummary
      expect(result.context).toBeDefined();
      expect(result.context?.graphContext?.inferredRelationshipSummary).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to generate inferred relationship summary',
        expect.anything(),
      );
    });

    it('should handle empty graph gracefully', async () => {
      const testResourceId = `resource-empty-graph-${Date.now()}`;
      const testAnnId = `ann-empty-graph-${Date.now()}`;
      await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
      await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

      (mockGraphDb.getResourceConnections as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getResourceReferencedBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      (mockGraphDb.getEntityTypeStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const result = await AnnotationContext.buildLLMContext(
        annotationId(testAnnId),
        resourceId(testResourceId),
        kb,
        {},
        undefined,
        mockLogger
      );

      expect(result.context?.graphContext).toEqual({
        connections: [],
        citedByCount: 0,
        citedBy: [],
        siblingEntityTypes: [],
        entityTypeFrequencies: {},
      });
    });
  });
});
