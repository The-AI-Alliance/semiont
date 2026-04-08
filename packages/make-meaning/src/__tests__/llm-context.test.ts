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
import { resourceId, userId, EventBus, type Logger } from '@semiont/core';
import type { GraphServiceConfig } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore } from '@semiont/content';
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

describe('LLM Context', () => {
  let teardown: () => Promise<void>;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let graphConfig: GraphServiceConfig;
  let kb: KnowledgeBase;
  let testResourceId: string;

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
    const resId = await ResourceOperations.createResource(
      {
        name: 'LLM Context Test Resource',
        content,
        format: 'text/plain',
      },
      userId('user-1'),
      eventBus,
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

      expect(result.mainResource).toBeDefined();
      expect(result.mainResource.name).toBe('LLM Context Test Resource');
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

      expect(result.relatedResources).toBeDefined();
      expect(Array.isArray(result.relatedResources)).toBe(true);
    });
  });

  describe('annotation inclusion', () => {
    it('should include annotations in context', async () => {
      // Create an annotation on the resource and await Stower persistence
      const created$ = firstValueFrom(eventBus.get('mark:create-ok').pipe(take(1)));
      const creator = { type: 'Person' as const, id: 'did:web:test.local:users:test-user', name: 'Test User' };
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

      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.annotations).toBeDefined();
      expect(Array.isArray(result.annotations)).toBe(true);
      expect(result.annotations.length).toBeGreaterThan(0);
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

      expect(result.mainResourceContent).toBeDefined();
      expect(result.mainResourceContent).toContain('This is test content');
    });

    it('should not include main resource content when includeContent is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.mainResourceContent).toBeUndefined();
    });

    it('should include related resources content when includeContent is true', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.relatedResourcesContent).toBeDefined();
      expect(typeof result.relatedResourcesContent).toBe('object');
    });

    it('should not include related resources content when includeContent is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.relatedResourcesContent).toBeUndefined();
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

      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe('string');
    });

    it('should not generate summary when includeSummary is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.summary).toBeUndefined();
    });

    it('should not generate summary when content not available', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: true },
        kb,
        mockClient
      );

      expect(result.summary).toBeUndefined();
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

      expect(result.suggestedReferences).toBeDefined();
      expect(Array.isArray(result.suggestedReferences)).toBe(true);
    });

    it('should not generate reference suggestions when content not available', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.suggestedReferences).toBeUndefined();
    });
  });

  describe('options handling', () => {
    it('should respect maxResources option', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 5, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      // Graph should respect maxResources limit
      expect(result.graph.nodes.length).toBeLessThanOrEqual(5);
    });

    it('should work with minimal options', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 1, includeContent: false, includeSummary: false },
        kb,
        mockClient
      );

      expect(result.mainResource).toBeDefined();
      expect(result.graph).toBeDefined();
      expect(result.annotations).toBeDefined();
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

      expect(result.mainResource).toBeDefined();
      expect(result.mainResourceContent).toBeDefined();
      expect(result.relatedResourcesContent).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.suggestedReferences).toBeDefined();
      expect(result.graph).toBeDefined();
      expect(result.annotations).toBeDefined();
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
      expect(result.mainResource).toBeDefined();
      expect(result.mainResource.name).toBe('LLM Context Test Resource');
      expect(result.mainResourceContent).toBeDefined();
      expect(result.relatedResources).toBeDefined();
      expect(result.relatedResourcesContent).toBeDefined();
      expect(result.annotations).toBeDefined();
      expect(result.graph).toBeDefined();
      expect(result.graph.nodes).toBeDefined();
      expect(result.graph.edges).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.suggestedReferences).toBeDefined();
    });
  });
});
