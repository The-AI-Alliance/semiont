/**
 * Scripting Example: Query Graph Database
 *
 * Demonstrates how to:
 * - Start make-meaning service with graph database
 * - Create resources and annotations
 * - Query the knowledge graph directly (no HTTP)
 * - Traverse relationships between resources and entities
 *
 * This pattern is useful for:
 * - Graph analysis scripts
 * - Knowledge extraction pipelines
 * - Relationship discovery
 * - Custom graph queries for reporting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, type Logger } from '@semiont/core';
import { startMakeMeaning, ResourceOperations, AnnotationOperations } from '../..';
import type { EnvironmentConfig } from '@semiont/core';
import { userId, resourceUri, uriToResourceId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference
const mockInferenceClient = vi.hoisted(() => ({ client: null as any }));

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockInferenceClient.client = new MockInferenceClient(['[]']);

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
    MockInferenceClient,
  };
});

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('Scripting Example: Query Graph Database', () => {
  let testDir: string;
  let config: EnvironmentConfig;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-graph-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration with in-memory graph
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
          type: 'memory' // Use in-memory graph for fast testing
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

    // Create EventBus
    eventBus = new EventBus();

    // Start make-meaning service
    makeMeaning = await startMakeMeaning(config, eventBus, mockLogger);
  });

  afterEach(async () => {
    // Stop service
    if (makeMeaning) {
      await makeMeaning.stop();
    }

    // Destroy EventBus
    if (eventBus) {
      eventBus.destroy();
    }

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('queries resources in the graph', async () => {
    // Create a test resource
    const result = await ResourceOperations.createResource(
      {
        name: 'Test Document',
        content: Buffer.from('Sample content for graph queries.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    const rUri = resourceUri(result.resource['@id']);

    // EVENTUAL CONSISTENCY: GraphConsumer receives events via global subscription
    // Wait for async processing to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Query graph directly via GraphDatabase interface
    const resource = await makeMeaning.graphDb.getResource(rUri);

    console.log(`Found resource: ${resource?.name || 'null'}`);

    // Verify resource exists in graph
    expect(resource).toBeDefined();
    expect(resource?.['@id']).toBe(result.resource['@id']);
    expect(resource?.name).toBe('Test Document');
  });

  it('queries annotations and their relationships', async () => {
    // Create a resource
    const resourceResult = await ResourceOperations.createResource(
      {
        name: 'Document with Annotation',
        content: Buffer.from('This is a test document with annotations.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    const rUri = resourceUri(resourceResult.resource['@id']);
    const rId = uriToResourceId(rUri);

    // Create an annotation
    await AnnotationOperations.createAnnotation(
      {
        motivation: 'commenting',
        body: [{ value: 'This is a test comment', type: 'text' }],
        target: {
          source: rUri,
          selector: {
            type: 'TextPositionSelector',
            start: 0,
            end: 10
          }
        }
      },
      userId('test-script'),
      makeMeaning.eventStore,
      config
    );

    // EVENTUAL CONSISTENCY: Wait for GraphConsumer to process events and update graph
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Query annotations using GraphDatabase interface
    const annotations = await makeMeaning.graphDb.getResourceAnnotations(rId);

    console.log(`Found ${annotations.length} annotations`);

    // Verify annotations exist
    expect(annotations.length).toBeGreaterThan(0);
    const annotation = annotations[0];
    expect(annotation.motivation).toBe('commenting');
  });

  it('demonstrates complex graph traversal', async () => {
    // Create multiple resources
    await ResourceOperations.createResource(
      {
        name: 'Document 1',
        content: Buffer.from('First document'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    await ResourceOperations.createResource(
      {
        name: 'Document 2',
        content: Buffer.from('Second document'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    // EVENTUAL CONSISTENCY: GraphConsumer receives events via global subscription
    // Wait for async processing to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Query resources using GraphDatabase interface
    const allResources = await makeMeaning.graphDb.listResources({});

    console.log(`Total resources in graph: ${allResources.total}`);

    // Verify both resources exist
    expect(allResources.total).toBeGreaterThanOrEqual(2);
    expect(allResources.resources.length).toBeGreaterThanOrEqual(2);

    // Find specific resources by name
    const foundDoc1 = allResources.resources.find(r => r.name === 'Document 1');
    const foundDoc2 = allResources.resources.find(r => r.name === 'Document 2');

    expect(foundDoc1).toBeDefined();
    expect(foundDoc2).toBeDefined();
  });

  it('demonstrates graph statistics query', async () => {
    // Create resources and annotations
    const resource = await ResourceOperations.createResource(
      {
        name: 'Stats Test Doc',
        content: Buffer.from('Document for statistics'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    const rUri = resourceUri(resource.resource['@id']);
    const rId = uriToResourceId(rUri);

    // Create a few annotations
    for (let i = 0; i < 3; i++) {
      await AnnotationOperations.createAnnotation(
        {
          motivation: 'commenting',
          body: [{ value: `Comment ${i + 1}`, type: 'text' }],
          target: {
            source: rUri,
            selector: {
              type: 'TextPositionSelector',
              start: i * 5,
              end: i * 5 + 5
            }
          }
        },
        userId('test-script'),
        makeMeaning.eventStore,
        config
      );
    }

    // EVENTUAL CONSISTENCY: Wait for GraphConsumer to process events and update graph
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Query graph statistics using GraphDatabase interface
    const stats = await makeMeaning.graphDb.getStats();
    const annotations = await makeMeaning.graphDb.getResourceAnnotations(rId);

    console.log('Graph statistics:');
    console.log(`  Total Resources: ${stats.resourceCount}`);
    console.log(`  Total Annotations: ${stats.annotationCount}`);
    console.log(`  Resource "${resource.resource.name}" has ${annotations.length} annotations`);

    expect(stats.resourceCount).toBeGreaterThan(0);
    expect(stats.annotationCount).toBeGreaterThanOrEqual(0);
    expect(annotations.length).toBeGreaterThanOrEqual(0);
  });

  it('demonstrates direct graph database access', async () => {
    // This shows you have full access to the graph database
    // via the GraphDatabase interface methods

    await ResourceOperations.createResource(
      {
        name: 'Custom Query Test',
        content: Buffer.from('Testing graph database queries'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    // EVENTUAL CONSISTENCY: GraphConsumer receives events via global subscription
    // Wait for async processing to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Search for resources using GraphDatabase interface
    const searchResults = await makeMeaning.graphDb.searchResources('Custom', 10);

    console.log('Search results:');
    searchResults.forEach(resource => {
      console.log(`  - ${resource.name} (${resource.format})`);
    });

    expect(searchResults.length).toBeGreaterThan(0);
    const found = searchResults.find(r => r.name === 'Custom Query Test');
    expect(found).toBeDefined();
  });
});
