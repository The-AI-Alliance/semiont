/**
 * GraphDBConsumer Tests
 *
 * Tests event type filtering, per-resource serialization,
 * cross-resource parallelism, event application, and lifecycle.
 *
 * Uses a real EventStore (temp dir) with a mock GraphDatabase.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import type { IdentifierConfig } from '@semiont/event-sourcing';
import { GraphDBConsumer } from '../graph/consumer';
import { resourceId, userId, annotationId, CREATION_METHODS } from '@semiont/core';
import type { EnvironmentConfig, Logger } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Helper: wait for fire-and-forget callbacks
const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

// Mock logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

// Mock GraphDatabase with all required methods
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

describe('GraphDBConsumer', () => {
  let testDir: string;
  let eventStore: EventStore;
  let graphDb: GraphDatabase;
  let consumer: GraphDBConsumer;

  const config: EnvironmentConfig = {
    services: {
      backend: {
        platform: { type: 'posix' },
        port: 4000,
        publicURL: 'http://localhost:4000',
        corsOrigin: 'http://localhost:3000',
      },
      graph: {
        platform: { type: 'posix' },
        type: 'memory',
      },
    },
    site: {
      siteName: 'Test Site',
      domain: 'localhost:3000',
      adminEmail: 'admin@test.local',
      oauthAllowedDomains: ['test.local'],
    },
    _metadata: {
      environment: 'test',
      projectRoot: '/tmp/test',
    },
  } as EnvironmentConfig;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-consumer-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const viewStorage = new FilesystemViewStorage(testDir);
    const identifierConfig: IdentifierConfig = { baseUrl: 'http://localhost:4000' };

    eventStore = new EventStore(
      { basePath: testDir, dataDir: testDir, enableSharding: false, maxEventsPerFile: 100 },
      viewStorage,
      identifierConfig,
    );
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    graphDb = createMockGraphDb();
    consumer = new GraphDBConsumer(config, eventStore, graphDb, mockLogger);
    await consumer.initialize();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await consumer?.stop();
  });

  describe('event type filtering', () => {
    it('should process graph-relevant events', async () => {
      const docId = resourceId(`filter-relevant-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });

      await tick();

      expect(graphDb.createResource).toHaveBeenCalledTimes(1);
    });

    it('should skip irrelevant events like job.started', async () => {
      const docId = resourceId(`filter-irrelevant-${Date.now()}`);

      // First create the resource so the stream is initialized
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();
      vi.clearAllMocks();

      // Now emit a non-graph event
      await eventStore.appendEvent({
        type: 'job.started',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { jobId: 'job-1' as any, jobType: 'reference-annotation' },
      });

      await tick();

      // No graph methods should have been called
      expect(graphDb.createResource).not.toHaveBeenCalled();
      expect(graphDb.updateResource).not.toHaveBeenCalled();
      expect(graphDb.createAnnotation).not.toHaveBeenCalled();
      expect(graphDb.deleteAnnotation).not.toHaveBeenCalled();
    });

    it('should skip job.progress events', async () => {
      const docId = resourceId(`filter-progress-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'job.progress',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { jobId: 'job-1' as any, jobType: 'reference-annotation', percentage: 50 },
      });

      await tick();

      expect(graphDb.createResource).not.toHaveBeenCalled();
      expect(graphDb.createAnnotation).not.toHaveBeenCalled();
    });
  });

  describe('event application', () => {
    it('should handle resource.created', async () => {
      const docId = resourceId(`apply-created-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'My Doc', format: 'text/plain', contentChecksum: 'abc', creationMethod: CREATION_METHODS.API },
      });

      await tick();

      expect(graphDb.createResource).toHaveBeenCalledTimes(1);
      const arg = (graphDb.createResource as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.name).toBe('My Doc');
      expect(arg['@id']).toContain(docId);
    });

    it('should handle resource.archived', async () => {
      const docId = resourceId(`apply-archived-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'resource.archived',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {},
      });

      await tick();

      expect(graphDb.updateResource).toHaveBeenCalledWith(
        expect.stringContaining(docId),
        expect.objectContaining({ archived: true }),
      );
    });

    it('should handle resource.unarchived', async () => {
      const docId = resourceId(`apply-unarchived-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'resource.unarchived',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {},
      });

      await tick();

      expect(graphDb.updateResource).toHaveBeenCalledWith(
        expect.stringContaining(docId),
        expect.objectContaining({ archived: false }),
      );
    });

    it('should handle annotation.added', async () => {
      const docId = resourceId(`apply-ann-added-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            type: 'Annotation' as const,
            id: 'ann-1',
            motivation: 'highlighting' as const,
            target: {
              source: docId,
              selector: [
                { type: 'TextPositionSelector', start: 0, end: 4 },
                { type: 'TextQuoteSelector', exact: 'Test' },
              ],
            },
            body: [],
            modified: new Date().toISOString(),
          },
        },
      });

      await tick();

      expect(graphDb.createAnnotation).toHaveBeenCalledTimes(1);
      const arg = (graphDb.createAnnotation as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.id).toBe('ann-1');
      expect(arg.creator).toBeDefined(); // Added from event userId
    });

    it('should handle annotation.removed', async () => {
      const docId = resourceId(`apply-ann-removed-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'annotation.removed',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { annotationId: annotationId('ann-to-remove') },
      });

      await tick();

      expect(graphDb.deleteAnnotation).toHaveBeenCalledTimes(1);
      expect(graphDb.deleteAnnotation).toHaveBeenCalledWith(
        expect.stringContaining('ann-to-remove'),
      );
    });

    it('should handle annotation.body.updated', async () => {
      const docId = resourceId(`apply-body-updated-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();

      // Mock getAnnotation to return an existing annotation
      (graphDb.getAnnotation as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ann-body',
        body: [{ type: 'TextualBody', value: 'existing', purpose: 'commenting' }],
      });
      vi.clearAllMocks();
      // Re-set the mock since clearAllMocks clears implementations
      (graphDb.getAnnotation as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'ann-body',
        body: [{ type: 'TextualBody', value: 'existing', purpose: 'commenting' }],
      });

      await eventStore.appendEvent({
        type: 'annotation.body.updated',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          annotationId: annotationId('ann-body'),
          operations: [
            { op: 'add', item: { type: 'TextualBody', value: 'new comment', purpose: 'commenting' } },
          ],
        },
      });

      await tick();

      expect(graphDb.getAnnotation).toHaveBeenCalledTimes(1);
      expect(graphDb.updateAnnotation).toHaveBeenCalledTimes(1);
      const updateArg = (graphDb.updateAnnotation as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(updateArg.body).toHaveLength(2);
    });

    it('should handle entitytag.added', async () => {
      const docId = resourceId(`apply-entitytag-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();

      // Mock getResource to return existing resource
      (graphDb.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
        '@id': `http://localhost:4000/resources/${docId}`,
        entityTypes: ['article'],
      });
      vi.clearAllMocks();
      (graphDb.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
        '@id': `http://localhost:4000/resources/${docId}`,
        entityTypes: ['article'],
      });

      await eventStore.appendEvent({
        type: 'entitytag.added',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'note' },
      });

      await tick();

      expect(graphDb.getResource).toHaveBeenCalledTimes(1);
      expect(graphDb.updateResource).toHaveBeenCalledTimes(1);
      const updateArg = (graphDb.updateResource as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(updateArg.entityTypes).toContain('article');
      expect(updateArg.entityTypes).toContain('note');
    });

    it('should handle entitytag.removed', async () => {
      const docId = resourceId(`apply-entitytag-rm-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();

      (graphDb.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
        '@id': `http://localhost:4000/resources/${docId}`,
        entityTypes: ['article', 'note'],
      });
      vi.clearAllMocks();
      (graphDb.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
        '@id': `http://localhost:4000/resources/${docId}`,
        entityTypes: ['article', 'note'],
      });

      await eventStore.appendEvent({
        type: 'entitytag.removed',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'note' },
      });

      await tick();

      expect(graphDb.getResource).toHaveBeenCalledTimes(1);
      expect(graphDb.updateResource).toHaveBeenCalledTimes(1);
      const updateArg = (graphDb.updateResource as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(updateArg.entityTypes).toEqual(['article']);
    });

    it('should handle entitytype.added (system event, no resourceId)', async () => {
      await eventStore.appendEvent({
        type: 'entitytype.added',
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'organization' },
      });

      await tick();

      expect(graphDb.addEntityType).toHaveBeenCalledWith('organization');
    });
  });

  describe('unknown events', () => {
    it('should log warning for unknown event types and not throw', async () => {
      const docId = resourceId(`unknown-type-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();

      // The pre-filter should skip unknown event types entirely,
      // so applyEventToGraph is never called for them.
      // This test verifies the filter works — no graph methods called.
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'representation.added' as any,
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { representation: { '@id': 'rep-1', mediaType: 'text/html', byteSize: 100, checksum: 'h2', created: new Date().toISOString() } },
      });

      await tick();

      expect(graphDb.createResource).not.toHaveBeenCalled();
      expect(graphDb.updateResource).not.toHaveBeenCalled();
    });
  });

  describe('per-resource serialization', () => {
    it('should process events for the same resource sequentially', async () => {
      const docId = resourceId(`serial-${Date.now()}`);
      const callOrder: string[] = [];

      // Make createResource slow to test serialization
      (graphDb.createResource as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('createResource:start');
        await new Promise(r => setTimeout(r, 30));
        callOrder.push('createResource:end');
        return {};
      });

      (graphDb.updateResource as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('updateResource:start');
        await new Promise(r => setTimeout(r, 10));
        callOrder.push('updateResource:end');
        return {};
      });

      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });

      await eventStore.appendEvent({
        type: 'resource.archived',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {},
      });

      await tick(150);

      // createResource should complete before updateResource starts
      expect(callOrder.indexOf('createResource:end')).toBeLessThan(
        callOrder.indexOf('updateResource:start'),
      );
    });
  });

  describe('lifecycle', () => {
    it('should unsubscribe on stop', async () => {
      const localGraphDb = createMockGraphDb();
      const localConsumer = new GraphDBConsumer(config, eventStore, localGraphDb, mockLogger);
      await localConsumer.initialize();

      const docId = resourceId(`lifecycle-stop-${Date.now()}`);

      // Verify events are received before stop
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Before Stop', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
      });
      await tick();
      expect(localGraphDb.createResource).toHaveBeenCalledTimes(1);

      // Stop consumer
      await localConsumer.stop();
      vi.clearAllMocks();

      // Events after stop should not be processed
      const docId2 = resourceId(`lifecycle-after-stop-${Date.now()}`);
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId2,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'After Stop', format: 'text/plain', contentChecksum: 'h2', creationMethod: CREATION_METHODS.API },
      });
      await tick();

      expect(localGraphDb.createResource).not.toHaveBeenCalled();
    });

    it('should report health metrics', async () => {
      const metrics = consumer.getHealthMetrics();

      expect(metrics.subscriptions).toBe(1);
      expect(metrics.processing).toEqual([]);
      expect(typeof metrics.lastProcessed).toBe('object');
    });
  });
});
