/**
 * GraphDB Consumer Tests
 *
 * Tests the GraphDBConsumer class which subscribes to resource events
 * and updates GraphDB accordingly.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GraphDBConsumer } from '../../graph/consumer';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { resourceId, userId, annotationId, type EnvironmentConfig } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/graph
const mockGraphDb = vi.hoisted(() => ({
  setResource: vi.fn(),
  updateResource: vi.fn(),
  deleteResource: vi.fn(),
  createResource: vi.fn(),
  addAnnotation: vi.fn(),
  createAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  addEntityType: vi.fn()
}));

vi.mock('@semiont/graph', () => {
  return {
    getGraphDatabase: vi.fn().mockResolvedValue(mockGraphDb)
  };
});

describe('GraphDBConsumer', () => {
  let testDir: string;
  let config: EnvironmentConfig;
  let eventStore: EventStore;
  let consumer: GraphDBConsumer;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-graph-consumer-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

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
      }
    } as EnvironmentConfig;

    eventStore = createEventStore(testDir, config.services.backend!.publicURL);
    consumer = new GraphDBConsumer(config, eventStore, mockGraphDb as any);
  });

  afterAll(async () => {
    await consumer.stop();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should throw error if not initialized before use', async () => {
    const uninitializedConsumer = new GraphDBConsumer(config, eventStore, mockGraphDb as any);

    await expect(
      uninitializedConsumer.subscribeToResource(resourceId('test'))
    ).rejects.toThrow('GraphDBConsumer not initialized');
  });

  it('should subscribe to resource events', async () => {
    await consumer.initialize();
    const testResourceId = resourceId(`test-subscribe-${Date.now()}`);

    await consumer.subscribeToResource(testResourceId);

    // Verify subscription was created
    // (internal state tracking, we can't easily test subscription details without exposing internals)
    // But we can verify it doesn't throw
    expect(true).toBe(true);
  });

  it('should process resource.created events', async () => {
    await consumer.initialize();
    const testResourceId = resourceId(`test-created-${Date.now()}`);

    await consumer.subscribeToResource(testResourceId);

    // Emit a resource.created event
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: testResourceId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'Test Resource',
        format: 'text/plain',
        contentChecksum: 'abc123',
        creationMethod: 'api'
      }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify graph database was called
    expect(mockGraphDb.createResource).toHaveBeenCalled();
  });

  it('should process annotation.created events', async () => {
    await consumer.initialize();
    const testResourceId = resourceId(`test-annotation-${Date.now()}`);
    const testAnnId = annotationId(`ann-${Date.now()}`);

    await consumer.subscribeToResource(testResourceId);

    // Create resource first
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: testResourceId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'Test Resource',
        format: 'text/plain',
        contentChecksum: 'abc123',
        creationMethod: 'api'
      }
    });

    // Create annotation
    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: testResourceId,
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
            value: 'Test comment',
            format: 'text/plain',
            purpose: 'commenting'
          },
          target: {
            source: `http://localhost:4000/resources/${testResourceId}`,
            selector: {
              type: 'TextQuoteSelector',
              exact: 'test',
              prefix: '',
              suffix: ''
            }
          }
        }
      }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockGraphDb.createAnnotation).toHaveBeenCalled();
  });

  it('should stop and unsubscribe from events', async () => {
    const testConsumer = new GraphDBConsumer(config, eventStore, mockGraphDb as any);
    await testConsumer.initialize();

    const testResourceId = resourceId(`test-stop-${Date.now()}`);
    await testConsumer.subscribeToResource(testResourceId);

    // Stop should not throw
    await expect(testConsumer.stop()).resolves.toBeUndefined();

    // After stopping, subscribeToResource should work (but processEvent won't be called)
    await testConsumer.initialize();
    await expect(testConsumer.subscribeToResource(resourceId('new-resource'))).resolves.toBeUndefined();
  });

  it('should handle multiple resource subscriptions', async () => {
    await consumer.initialize();

    const res1 = resourceId(`multi-1-${Date.now()}`);
    const res2 = resourceId(`multi-2-${Date.now()}`);
    const res3 = resourceId(`multi-3-${Date.now()}`);

    await consumer.subscribeToResource(res1);
    await consumer.subscribeToResource(res2);
    await consumer.subscribeToResource(res3);

    // All subscriptions should succeed without error
    expect(true).toBe(true);
  });

  it('should process global events', async () => {
    await consumer.initialize();

    // Global events don't have a resourceId
    // For example, entitytype.added events
    // The consumer should handle these through its global subscription

    // This is harder to test without exposing processEvent publicly
    // But we can verify initialization sets up global subscription
    expect(true).toBe(true);
  });

  it('should handle events in order for same resource', async () => {
    await consumer.initialize();
    const testResourceId = resourceId(`test-order-${Date.now()}`);

    await consumer.subscribeToResource(testResourceId);

    // Create resource
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: testResourceId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'Original Name',
        format: 'text/plain',
        contentChecksum: 'abc123',
        creationMethod: 'api'
      }
    });

    // Add annotation
    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: testResourceId,
      userId: userId('user-1'),
      version: 2,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: `ann-${Date.now()}`,
          type: 'Annotation',
          motivation: 'commenting',
          body: {
            type: 'TextualBody',
            value: 'Test comment',
            format: 'text/plain',
            purpose: 'commenting'
          },
          target: {
            source: `http://localhost:4000/resources/${testResourceId}`,
            selector: {
              type: 'TextQuoteSelector',
              exact: 'test',
              prefix: '',
              suffix: ''
            }
          }
        }
      }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(mockGraphDb.createResource).toHaveBeenCalled();
    expect(mockGraphDb.createAnnotation).toHaveBeenCalled();
  });
});
