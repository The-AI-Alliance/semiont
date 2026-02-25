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
import { LLMContext } from '../llm-context';
import { ResourceOperations } from '../resource-operations';
import { AnnotationOperations } from '../annotation-operations';
import { resourceId, userId, type EnvironmentConfig, type Logger } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore, type RepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  let testDir: string;
  let eventStore: EventStore;
  let repStore: RepresentationStore;
  let config: EnvironmentConfig;
  let testResourceId: string;

  beforeAll(async () => {
    // Initialize mock client
    const { MockInferenceClient } = await import('@semiont/inference');
    mockClient = new MockInferenceClient([
      'Test summary of the resource',
      JSON.stringify(['Reference 1', 'Reference 2'])
    ]);

    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-llm-context-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration
    config = {
      services: {
        filesystem: {
          platform: { type: 'posix' },
          path: testDir
        },
        backend: {
          platform: { type: 'posix' },
          port: 4000,
          publicURL: 'http://localhost:4000',
          corsOrigin: 'http://localhost:3000'
        },
        inference: {
          platform: { type: 'external' },
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          endpoint: 'https://api.anthropic.com',
          apiKey: 'test-api-key'
        },
        graph: {
          platform: { type: 'posix' },
          type: 'memory'
        }
      },
      site: {
        siteName: 'Test Site',
        domain: 'localhost:3000',
        adminEmail: 'admin@test.local',
        oauthAllowedDomains: ['test.local']
      },
      _metadata: {
        environment: 'test',
        projectRoot: testDir
      },
    } as EnvironmentConfig;

    // Initialize stores
    eventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);
    repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir, mockLogger);

    // Create a test resource
    const content = Buffer.from('This is test content for LLM context building.', 'utf-8');
    const response = await ResourceOperations.createResource(
      {
        name: 'LLM Context Test Resource',
        content,
        format: 'text/plain',
      },
      userId('user-1'),
      eventStore,
      repStore,
      config
    );

    const idMatch = response.resource['@id'].match(/\/resources\/(.+)$/);
    testResourceId = idMatch![1];

    // Populate graph database (required by GraphContext)
    const { getGraphDatabase } = await import('@semiont/graph');
    const graphDb = await getGraphDatabase(config);
    await graphDb.createResource(response.resource);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('resource context retrieval', () => {
    it('should retrieve main resource metadata', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        config,
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
          config,
          mockClient
        )
      ).rejects.toThrow('Resource not found');
    });

    it('should return empty related resources when none exist', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        config,
        mockClient
      );

      expect(result.relatedResources).toBeDefined();
      expect(Array.isArray(result.relatedResources)).toBe(true);
    });
  });

  describe('annotation inclusion', () => {
    it('should include annotations in context', async () => {
      // Create an annotation on the resource
      await AnnotationOperations.createAnnotation(
        {
          motivation: 'highlighting',
          target: {
            source: `http://localhost:4000/resources/${testResourceId}`,
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
        eventStore,
        config
      );

      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        config,
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
        config,
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
        config,
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
        config,
        mockClient
      );

      expect(result.mainResourceContent).toBeDefined();
      expect(result.mainResourceContent).toContain('This is test content');
    });

    it('should not include main resource content when includeContent is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        config,
        mockClient
      );

      expect(result.mainResourceContent).toBeUndefined();
    });

    it('should include related resources content when includeContent is true', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        config,
        mockClient
      );

      expect(result.relatedResourcesContent).toBeDefined();
      expect(typeof result.relatedResourcesContent).toBe('object');
    });

    it('should not include related resources content when includeContent is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        config,
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
        config,
        mockClient
      );

      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe('string');
    });

    it('should not generate summary when includeSummary is false', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: true, includeSummary: false },
        config,
        mockClient
      );

      expect(result.summary).toBeUndefined();
    });

    it('should not generate summary when content not available', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: true },
        config,
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
        config,
        mockClient
      );

      expect(result.suggestedReferences).toBeDefined();
      expect(Array.isArray(result.suggestedReferences)).toBe(true);
    });

    it('should not generate reference suggestions when content not available', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 10, includeContent: false, includeSummary: false },
        config,
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
        config,
        mockClient
      );

      // Graph should respect maxResources limit
      expect(result.graph.nodes.length).toBeLessThanOrEqual(5);
    });

    it('should work with minimal options', async () => {
      const result = await LLMContext.getResourceContext(
        resourceId(testResourceId),
        { depth: 1, maxResources: 1, includeContent: false, includeSummary: false },
        config,
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
        config,
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
        config,
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
