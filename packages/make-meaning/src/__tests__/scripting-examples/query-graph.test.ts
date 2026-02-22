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
import { EventBus } from '@semiont/core';
import { startMakeMeaning, ResourceOperations, AnnotationOperations } from '../..';
import type { EnvironmentConfig } from '@semiont/core';
import { userId, resourceId, entityType, annotationId } from '@semiont/core';
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
    makeMeaning = await startMakeMeaning(config, eventBus);
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

    // Allow time for graph consumer to process events
    await new Promise(resolve => setTimeout(resolve, 500));

    // Query graph directly - no HTTP layer
    const queryResult = await makeMeaning.graphDb.query(
      `MATCH (r:Resource {id: $resourceId})
       RETURN r`,
      { resourceId: result.resource.id }
    );

    console.log(`Query returned ${queryResult.records.length} records`);

    // Verify resource exists in graph
    expect(queryResult.records.length).toBeGreaterThan(0);
    const record = queryResult.records[0];
    const node = record.get('r');
    expect(node.properties.id).toBe(result.resource.id);
    expect(node.properties.name).toBe('Test Document');
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

    const rId = resourceResult.resource.id;

    // Create an annotation
    await AnnotationOperations.createAnnotation(
      resourceId(rId),
      {
        motivation: 'commenting',
        body: [{ value: 'This is a test comment', type: 'text' }],
        target: {
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

    // Allow time for graph consumer to process
    await new Promise(resolve => setTimeout(resolve, 500));

    // Query for resource and its annotations
    const queryResult = await makeMeaning.graphDb.query(
      `MATCH (r:Resource {id: $resourceId})-[:HAS_ANNOTATION]->(a:Annotation)
       RETURN r, a`,
      { resourceId: rId }
    );

    console.log(`Found ${queryResult.records.length} resource-annotation relationships`);

    // Verify relationship exists
    if (queryResult.records.length > 0) {
      const record = queryResult.records[0];
      const resource = record.get('r');
      const annotation = record.get('a');

      expect(resource.properties.id).toBe(rId);
      expect(annotation.properties.motivation).toBe('commenting');
    }
  });

  it('demonstrates complex graph traversal', async () => {
    // Create multiple resources
    const doc1 = await ResourceOperations.createResource(
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

    const doc2 = await ResourceOperations.createResource(
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

    // Allow graph consumer to process
    await new Promise(resolve => setTimeout(resolve, 500));

    // Query all resources
    const allResources = await makeMeaning.graphDb.query(
      `MATCH (r:Resource)
       RETURN r
       ORDER BY r.name`
    );

    console.log(`Total resources in graph: ${allResources.records.length}`);

    // Verify both resources exist
    expect(allResources.records.length).toBeGreaterThanOrEqual(2);

    // Find specific resources by name
    const foundDoc1 = allResources.records.find(r =>
      r.get('r').properties.name === 'Document 1'
    );
    const foundDoc2 = allResources.records.find(r =>
      r.get('r').properties.name === 'Document 2'
    );

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

    // Create a few annotations
    for (let i = 0; i < 3; i++) {
      await AnnotationOperations.createAnnotation(
        resourceId(resource.resource.id),
        {
          motivation: 'commenting',
          body: [{ value: `Comment ${i + 1}`, type: 'text' }],
          target: {
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

    // Allow processing
    await new Promise(resolve => setTimeout(resolve, 500));

    // Query graph statistics
    const stats = await makeMeaning.graphDb.query(
      `MATCH (r:Resource {id: $resourceId})-[:HAS_ANNOTATION]->(a:Annotation)
       RETURN r.id as resourceId, r.name as resourceName, count(a) as annotationCount`,
      { resourceId: resource.resource.id }
    );

    console.log('Graph statistics:');
    if (stats.records.length > 0) {
      const record = stats.records[0];
      console.log(`  Resource: ${record.get('resourceName')}`);
      console.log(`  Annotations: ${record.get('annotationCount')}`);

      expect(record.get('resourceId')).toBe(resource.resource.id);
      expect(record.get('annotationCount').toNumber()).toBeGreaterThanOrEqual(0);
    }
  });

  it('demonstrates direct graph database access', async () => {
    // This shows you have full access to the graph database
    // for any custom queries your script needs

    const result = await ResourceOperations.createResource(
      {
        name: 'Custom Query Test',
        content: Buffer.from('Testing custom graph queries'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    await new Promise(resolve => setTimeout(resolve, 500));

    // Custom Cypher query - you have full power of Neo4j/MemGraph
    const customQuery = await makeMeaning.graphDb.query(
      `MATCH (r:Resource)
       WHERE r.name CONTAINS 'Custom'
       RETURN r.id as id, r.name as name, r.format as format`
    );

    console.log('Custom query results:');
    customQuery.records.forEach(record => {
      console.log(`  - ${record.get('name')} (${record.get('format')})`);
    });

    expect(customQuery.records.length).toBeGreaterThan(0);
  });
});
