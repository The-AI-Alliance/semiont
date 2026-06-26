/**
 * LLM Context Tests
 *
 * Tests the LLM context building orchestration:
 * - Resource context retrieval (main + related)
 * - Annotation inclusion
 * - Graph representation building
 * - Content loading (main + related)
 * - Summary generation
 * - Reference suggestions
 * - Options handling (depth, maxResources, includeContent, includeSummary)
 * - Error handling (resource not found)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { LLMContext } from '../llm-context';
import { ResourceOperations } from '../resource-operations';
import { AnnotationOperations } from '../annotation-operations';
import { resourceId, annotationId, userId, EventBus, type Logger, type SupportedMediaType } from '@semiont/core';
import type { GraphServiceConfig, GatheredContext } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore, deriveStorageUri } from '@semiont/content';
import type { KnowledgeBase } from '../knowledge-base';
import { Stower } from '../stower';
import { createTestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

// getResourceContext returns a unified GatheredContext with focus.kind:'resource' (CONTEXT-UNIFICATION P3).
function resFocus(ctx: GatheredContext) {
  if (ctx.focus.kind !== 'resource') throw new Error('expected resource focus');
  return ctx.focus;
}

// Mock @semiont/inference to avoid external API calls
let mockClient: any;
vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  const client = new MockInferenceClient(['[]']);
  return {
    getInferenceClient: vi.fn().mockResolvedValue(client),
    MockInferenceClient
  };
});

let fileCounter = 0;

describe('LLM Context', () => {
  let teardown: () => Promise<void>;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let graphConfig: GraphServiceConfig;
  let kb: KnowledgeBase;
  let testResourceId: string;

  async function create(
    opts: { name: string; content: Buffer; format: SupportedMediaType; language?: string },
    uid: ReturnType<typeof userId>,
  ) {
    const uri = deriveStorageUri(`test-${++fileCounter}`, opts.format);
    const stored = await kb.content.store(opts.content, uri);
    return ResourceOperations.createResource(
      { name: opts.name, storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format: opts.format, language: opts.language },
      uid,
      eventBus,
    );
  }

  beforeAll(async () => {
    // Initialize mock client
    const { MockInferenceClient } = await import('@semiont/inference');
    mockClient = new MockInferenceClient([
      'Test summary of the resource',
      JSON.stringify(['Reference 1', 'Reference 2'])
    ]);

    graphConfig = { type: 'memory' } as GraphServiceConfig;

    const { project, teardown: td } = await createTestProject('llm-context');
    teardown = td;

    // Initialize EventBus and stores
    eventBus = new EventBus();
    eventStore = createEventStore(project, eventBus, mockLogger);

    // Create KnowledgeBase - share event store's view storage to avoid separate instances
    const { getGraphDatabase } = await import('@semiont/graph');
    const graphDb = await getGraphDatabase(graphConfig);
    kb = { eventStore, views: eventStore.viewStorage, content: new WorkingTreeStore(project, mockLogger), graph: graphDb, projectionsDir: project.projectionsDir, graphConsumer: {} as any };

    // Start Stower
    stower = new Stower(kb, eventBus, mockLogger);
    await stower.initialize();

    // Create a test resource
    const content = Buffer.from('This is test content for LLM context building.', 'utf-8');
    const resId = await create(
      {
        name: 'LLM Context Test Resource',
        content,
        format: 'text/plain',
      },
      userId('user-1'),
    );

    testResourceId = resId;

    // Populate graph database (required by GraphContext)
    // Construct a minimal ResourceDescriptor since createResource now returns only ResourceId
    await kb.graph.createResource({
      '@context': 'https://www.w3.org/ns/anno.jsonld',
      '@id': resId,
      name: 'LLM Context Test Resource',
      archived: false,
      entityTypes: [],
      representations: { mediaType: 'text/plain', rel: 'original', checksum: '', byteSize: content.length },
    });
  });

  afterAll(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('resource context retrieval', () => {
    it('should retrieve main resource metadata', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).resource).toBeDefined();
      expect(resFocus(result).resource.name).toBe('LLM Context Test Resource');
    });

    it('should throw if resource not found', async () => {
      await expect(
        LLMContext.getResourceContext(
          resourceId('non-existent-resource'),
          { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
          kb,
          mockClient
        )
      ).rejects.toThrow('Resource not found');
    });

    it('should return empty related resources when none exist', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      const related = result.graph.nodes.filter((n) => n.type === 'resource' && n.id !== testResourceId);
      expect(related).toEqual([]);
    });
  });

  describe('annotation inclusion', () => {
    it('should include annotations in context', async () => {
      // Create an annotation on the resource and await Stower persistence.
      // mark:create-ok is emitted by annotation-assembly in response to
      // mark:added; this test emits mark:create directly, so we await the
      // persisted mark:added domain event instead.
      const created$ = firstValueFrom(eventBus.get('mark:added').pipe(take(1)));
      const creator = { '@type': 'Person' as const, '@id': 'did:web:test.local:users:test-user', name: 'Test User' };
      await AnnotationOperations.createAnnotation(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceId,
            selector: [{
              type: 'TextPositionSelector',
              start: 0,
              end: 4
            }]
          },
          body: {
            type: 'TextualBody',
            value: 'Test annotation',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        creator,
        eventBus,
      );
      await created$;

      // The unified context sources annotations from the graph projection; this test's kb wires no
      // graph consumer, so add the annotation to the graph store directly.
      await kb.graph.createAnnotation({
        id: annotationId('llm-graph-ann'),
        motivation: 'highlighting',
        target: { source: testResourceId, selector: [{ type: 'TextPositionSelector', start: 0, end: 4 }] },
        creator,
      });

      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      const annotationNodes = result.graph.nodes.filter((n) => n.type === 'annotation');
      expect(annotationNodes.length).toBeGreaterThan(0);
    });
  });

  describe('graph representation', () => {
    it('should include graph representation', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.graph).toBeDefined();
      expect(result.graph.nodes).toBeDefined();
      expect(Array.isArray(result.graph.nodes)).toBe(true);
      expect(result.graph.edges).toBeDefined();
      expect(Array.isArray(result.graph.edges)).toBe(true);
    });

    it('should include main resource in graph nodes', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      const mainResourceNode = result.graph.nodes.find(n => n.id === testResourceId);
      expect(mainResourceNode).toBeDefined();
    });
  });

  describe('content loading', () => {
    it('should include main resource content when includeContent is true', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).content?.main).toBeDefined();
      expect(resFocus(result).content?.main).toContain('This is test content');
    });

    it('should not include main resource content when includeContent is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).content?.main).toBeUndefined();
    });

    it('should include related resources content when includeContent is true', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).content?.related).toBeDefined();
      expect(typeof resFocus(result).content?.related).toBe('object');
    });

    it('should not include related resources content when includeContent is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).content?.related).toBeUndefined();
    });
  });

  describe('summary generation', () => {
    it('should generate summary when includeSummary is true and content available', async () => {
      mockClient.setResponses(['Generated summary text']);

      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: true },
        kb,
        mockClient
      );

      expect(resFocus(result).summary).toBeDefined();
      expect(typeof resFocus(result).summary).toBe('string');
    });

    it('should not generate summary when includeSummary is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).summary).toBeUndefined();
    });

    it('should not generate summary when content not available', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: true },
        kb,
        mockClient
      );

      expect(resFocus(result).summary).toBeUndefined();
    });
  });

  describe('reference suggestions', () => {
    it('should generate reference suggestions when content available', async () => {
      mockClient.setResponses([
        'Summary',
        JSON.stringify(['Ref 1', 'Ref 2', 'Ref 3'])
      ]);

      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).suggestedReferences).toBeDefined();
      expect(Array.isArray(resFocus(result).suggestedReferences)).toBe(true);
    });

    it('should not generate reference suggestions when content not available', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).suggestedReferences).toBeUndefined();
    });
  });

  describe('options handling', () => {
    it('should cap related-resource content by maxResources (a view concern, Q2=C)', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 5, includeContent: true, includeSummary: false },
        kb,
        mockClient
      );

      // The graph is the full neighborhood; maxResources caps the related-resource *content*
      // (at most maxResources - 1 peers).
      const related = resFocus(result).content?.related ?? {};
      expect(Object.keys(related).length).toBeLessThanOrEqual(4);
    });

    it('should work with minimal options', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 1, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(resFocus(result).resource).toBeDefined();
      expect(result.graph).toBeDefined();
      expect(result.graph.nodes.length).toBeGreaterThan(0);
    });

    it('should work with maximal options', async () => {
      mockClient.setResponses([
        'Summary text',
        JSON.stringify(['Ref A', 'Ref B'])
      ]);

      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 2, maxResources: 50, includeContent: true, includeSummary: true },
        kb,
        mockClient
      );

      expect(resFocus(result).resource).toBeDefined();
      expect(resFocus(result).content?.main).toBeDefined();
      expect(resFocus(result).content?.related).toBeDefined();
      expect(resFocus(result).summary).toBeDefined();
      expect(resFocus(result).suggestedReferences).toBeDefined();
      expect(result.graph).toBeDefined();
      expect(result.graph.nodes.length).toBeGreaterThan(0);
    });
  });

  describe('integration', () => {
    it('should build complete context with all components', async () => {
      mockClient.setResponses([
        'Comprehensive summary of the test resource',
        JSON.stringify(['Related Reference 1', 'Related Reference 2'])
      ]);

      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 20, includeContent: true, includeSummary: true },
        kb,
        mockClient
      );

      // Verify all major components are present
      expect(resFocus(result).resource).toBeDefined();
      expect(resFocus(result).resource.name).toBe('LLM Context Test Resource');
      expect(resFocus(result).content?.main).toBeDefined();
      expect(result.graph.nodes.some((n) => n.type === 'resource')).toBe(true);
      expect(resFocus(result).content?.related).toBeDefined();
      expect(result.graph.nodes.some((n) => n.type === 'annotation')).toBe(true);
      expect(result.graph).toBeDefined();
      expect(result.graph.nodes).toBeDefined();
      expect(result.graph.edges).toBeDefined();
      expect(resFocus(result).summary).toBeDefined();
      expect(resFocus(result).suggestedReferences).toBeDefined();
    });
  });

  describe('semantic context (EXCLUDE-VECTORS Phase 2b)', () => {
    // The fake vector store returns this pool from searchByResource, applying
    // the excludeEntityTypes filter itself (the real store's job — already
    // tested in @semiont/vectors). Here we verify getResourceContext forwards
    // the filter, maps results, and records the exclusion as provenance.
    const pool = [
      { id: 'r-answer#0', score: 0.9, resourceId: 'r-answer', text: 'a prior answer', entityTypes: ['Answer'] },
      { id: 'r-question#0', score: 0.8, resourceId: 'r-question', text: 'a prior question', entityTypes: ['Question'] },
    ];
    const baseOpts = { depth: 1, maxResources: 5, includeContent: false, includeSummary: false };

    function kbWithVectors(capture?: (opts: any) => void): KnowledgeBase {
      return {
        ...kb,
        vectors: {
          searchByResource: vi.fn(async (_rid: any, opts: any) => {
            capture?.(opts);
            const exclude = new Set<string>(opts.filter?.excludeEntityTypes ?? []);
            return pool.filter((p) => !p.entityTypes.some((t) => exclude.has(t)));
          }),
        } as any,
      };
    }

    it('populates semanticContext from searchByResource', async () => {
      const ctx = await LLMContext.getResourceContext(resourceId(testResourceId), baseOpts, kbWithVectors(), mockClient);
      expect(ctx.semanticContext?.similar.map((s) => s.resourceId).sort()).toEqual(['r-answer', 'r-question']);
    });

    it('omits excluded-entity-type resources and records the exclusion', async () => {
      let seen: any;
      const ctx = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { ...baseOpts, excludeEntityTypes: ['Question'] },
        kbWithVectors((o) => { seen = o; }),
        mockClient,
      );
      expect(seen.filter.excludeEntityTypes).toEqual(['Question']);             // filter forwarded
      expect(ctx.semanticContext?.similar.map((s) => s.resourceId)).toEqual(['r-answer']); // Question omitted
      expect(ctx.semanticContext?.excludedEntityTypes).toEqual(['Question']);   // provenance recorded
    });

    it('records no excludedEntityTypes when no exclusion is applied', async () => {
      const ctx = await LLMContext.getResourceContext(resourceId(testResourceId), baseOpts, kbWithVectors(), mockClient);
      expect(ctx.semanticContext?.excludedEntityTypes).toBeUndefined();
    });

    it('leaves semanticContext absent when no vector store is configured', async () => {
      const ctx = await LLMContext.getResourceContext(resourceId(testResourceId), baseOpts, kb, mockClient);
      expect(ctx.semanticContext).toBeUndefined();
    });
  });
});
