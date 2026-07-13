/**
 * Weaver Tests
 *
 * Tests event type filtering, per-resource serialization,
 * cross-resource parallelism, event application, burst batching, and lifecycle.
 *
 * Uses a real EventStore (temp dir) with a mock GraphDatabase.
 *
 * Note: The consumer uses an RxJS pipeline with a burstBuffer operator.
 * First event for a resource passes through immediately (leading edge).
 * Subsequent events within the burst window (50ms) are buffered and flushed as a batch.
 * Tests use tick(350) to ensure burst window + idle timeout (50+200ms) complete.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { Weaver } from '../weaver';
import { createWeaverActorStateUnit, type WeaverActorStateUnit } from '../weaver-actor-state-unit';
import { workerBusOverEventBus } from '../worker-bus-local';
import { asBusRequestPrimitive } from '../bus-request-local';
import { FileWeaverCheckpoint } from '../weaver-checkpoint';
import { busRequest } from '@semiont/core';
import { resourceId, userId, annotationId, EventBus } from '@semiont/core';
import type { Logger } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import { MemoryGraphDatabase } from '@semiont/graph';
import type { StoredEvent } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Helper: wait for fire-and-forget callbacks + burst buffer flush + idle timeout
const tick = (ms = 350) => new Promise(resolve => setTimeout(resolve, ms));

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

describe('Weaver', () => {
  let testDir: string;
  let project: SemiontProject;
  let eventStore: EventStore;
  let coreEventBus: EventBus;
  let graphDb: GraphDatabase;
  let consumer: Weaver;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-consumer-test-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });

    project = new SemiontProject(testDir);
    const viewStorage = new FilesystemViewStorage(project);
    coreEventBus = new EventBus();

    eventStore = new EventStore(
      project,
      testDir,
      viewStorage,
      coreEventBus,
    );
  });

  afterAll(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  let weaverUnit: WeaverActorStateUnit;

  const wireWeaver = async (db: GraphDatabase, checkpointPath?: string): Promise<Weaver> => {
    const workerBus = workerBusOverEventBus(coreEventBus);
    weaverUnit = createWeaverActorStateUnit({ bus: workerBus });
    const weaver = new Weaver(
      db,
      weaverUnit.events$,
      weaverUnit.rebuilds$,
      asBusRequestPrimitive(coreEventBus),
      new FileWeaverCheckpoint(checkpointPath ?? join(testDir, `weaver-checkpoint-${uuidv4()}.json`)),
      mockLogger,
    );
    await weaver.initialize();
    weaverUnit.start();
    return weaver;
  };

  beforeEach(async () => {
    graphDb = createMockGraphDb();
    consumer = await wireWeaver(graphDb);
    vi.clearAllMocks();
  });

  // Bus responders standing in for the Browser: the Weaver's catch-up,
  // rebuild, and reconcile paths read history and views exclusively over
  // `browse:*` — these are their only view of the log in this harness.
  let stopServing: (() => void) | null = null;

  const serveBrowseReads = (rids: string[], annotationsByRid: Record<string, unknown[]> = {}) => {
    const subs = [
      coreEventBus.get('browse:resources-requested').subscribe((req: any) => {
        coreEventBus.get('browse:resources-result').next({
          correlationId: req.correlationId,
          response: {
            resources: rids.map((id) => ({
              '@id': id, name: id, representations: [], archived: false, entityTypes: [],
            })),
            total: rids.length,
          },
        } as any);
      }),
      coreEventBus.get('browse:events-requested').subscribe((req: any) => {
        void eventStore.log.getEvents(resourceId(req.resourceId)).then((events) => {
          coreEventBus.get('browse:events-result').next({
            correlationId: req.correlationId,
            response: { events, total: events.length, resourceId: req.resourceId },
          } as any);
        });
      }),
      coreEventBus.get('browse:annotations-requested').subscribe((req: any) => {
        coreEventBus.get('browse:annotations-result').next({
          correlationId: req.correlationId,
          response: { annotations: annotationsByRid[req.resourceId] ?? [] },
        } as any);
      }),
    ];
    stopServing = () => subs.forEach((s) => s.unsubscribe());
  };

  afterEach(async () => {
    await consumer?.stop();
    weaverUnit?.dispose();
    stopServing?.();
    stopServing = null;
  });

  describe('event type filtering', () => {
    it('should process graph-relevant events', async () => {
      const docId = resourceId(`filter-relevant-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });

      await tick();

      expect(graphDb.createResource).toHaveBeenCalledTimes(1);
    });

    it('should skip irrelevant events like job.started', async () => {
      const docId = resourceId(`filter-irrelevant-${Date.now()}`);

      // First create the resource so the stream is initialized
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      vi.clearAllMocks();

      // Now emit a non-graph event
      await eventStore.appendEvent({
        type: 'job:started',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'job:progress',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'My Doc', format: 'text/plain', contentChecksum: 'abc' },
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'mark:archived',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'mark:unarchived',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'mark:added',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            type: 'Annotation' as const,
            id: annotationId('ann-1'),
            motivation: 'highlighting' as const,
            target: {
              source: docId,
              selector: [
                { type: 'TextPositionSelector', start: 0, end: 4 },
                { type: 'TextQuoteSelector', exact: 'Test' },
              ],
            },
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'mark:removed',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();

      // Mock getAnnotation to return an existing annotation
      (graphDb.getAnnotation as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: annotationId('ann-body'),
        body: [{ type: 'TextualBody', value: 'existing', purpose: 'commenting' }],
      });
      vi.clearAllMocks();
      // Re-set the mock since clearAllMocks clears implementations
      (graphDb.getAnnotation as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: annotationId('ann-body'),
        body: [{ type: 'TextualBody', value: 'existing', purpose: 'commenting' }],
      });

      await eventStore.appendEvent({
        type: 'mark:body-updated',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
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
        type: 'mark:entity-tag-added',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
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
        type: 'mark:entity-tag-removed',
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

    // The -added fold must be idempotent per event, mirroring the view
    // materializer's includes-guard — duplicate adds must not diverge the
    // graph from the view (bugs/weaver-entity-tag-add-not-idempotent.md).
    it('entitytag.added for a tag the graph doc already has leaves a single copy', async () => {
      const docId = resourceId(`apply-entitytag-dup-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();

      vi.clearAllMocks();
      // The graph doc ALREADY carries the tag (e.g. a stale caller diff base
      // minted a duplicate -added, or the event is a historical duplicate).
      (graphDb.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
        '@id': `http://localhost:4000/resources/${docId}`,
        entityTypes: ['article', 'note'],
      });

      await eventStore.appendEvent({
        type: 'mark:entity-tag-added',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'note' },
      });
      await tick();

      // Idempotent fold: the tag is already present — no duplicating update.
      expect(graphDb.updateResource).not.toHaveBeenCalled();
    });

    it('the same entitytag.added delivered twice leaves a single copy', async () => {
      const docId = resourceId(`apply-entitytag-redeliver-${Date.now()}`);

      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();

      vi.clearAllMocks();
      (graphDb.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
        '@id': `http://localhost:4000/resources/${docId}`,
        entityTypes: ['article'],
      });

      await eventStore.appendEvent({
        type: 'mark:entity-tag-added',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'note' },
      });
      await tick();

      // First delivery applies…
      expect(graphDb.updateResource).toHaveBeenCalledTimes(1);
      expect(
        (graphDb.updateResource as ReturnType<typeof vi.fn>).mock.calls[0][1].entityTypes,
      ).toEqual(['article', 'note']);

      // …and once the graph reflects it, redelivery of the same fact is a no-op.
      (graphDb.getResource as ReturnType<typeof vi.fn>).mockResolvedValue({
        '@id': `http://localhost:4000/resources/${docId}`,
        entityTypes: ['article', 'note'],
      });

      await eventStore.appendEvent({
        type: 'mark:entity-tag-added',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { entityType: 'note' },
      });
      await tick();

      expect(graphDb.updateResource).toHaveBeenCalledTimes(1);
    });

    it('should handle entitytype.added (system event, no resourceId)', async () => {
      await eventStore.appendEvent({
        type: 'frame:entity-type-added',
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();

      // The pre-filter should skip unknown event types entirely,
      // so applyEventToGraph is never called for them.
      // This test verifies the filter works — no graph methods called.
      vi.clearAllMocks();

      await eventStore.appendEvent({
        type: 'yield:representation-added' as any,
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
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });

      await eventStore.appendEvent({
        type: 'mark:archived',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {},
      });

      await tick(500);

      // createResource should complete before updateResource starts
      // (burst buffer groups them but concatMap ensures sequential processing)
      expect(callOrder.indexOf('createResource:end')).toBeLessThan(
        callOrder.indexOf('updateResource:start'),
      );
    });
  });

  describe('burst batching', () => {
    it('should batch multiple annotation.added events via createAnnotations', async () => {
      const docId = resourceId(`burst-batch-${Date.now()}`);

      // Create the resource first and wait for full cycle
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      vi.clearAllMocks();

      // Rapidly emit multiple annotation.added events (simulating bulk inference)
      for (let i = 0; i < 5; i++) {
        await eventStore.appendEvent({
          type: 'mark:added',
          resourceId: docId,
          userId: userId('user1'),
          version: 1,
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              type: 'Annotation' as const,
              id: annotationId(`ann-batch-${i}`),
              motivation: 'highlighting' as const,
              target: {
                source: docId,
                selector: [
                  { type: 'TextPositionSelector', start: i * 10, end: i * 10 + 5 },
                  { type: 'TextQuoteSelector', exact: `text${i}` },
                ],
              },
              modified: new Date().toISOString(),
            },
          },
        });
      }

      await tick(500);

      // First annotation passes through immediately via createAnnotation (leading edge)
      // Remaining 4 should be batched via createAnnotations
      const singleCalls = (graphDb.createAnnotation as ReturnType<typeof vi.fn>).mock.calls.length;
      const batchCalls = (graphDb.createAnnotations as ReturnType<typeof vi.fn>).mock.calls.length;

      // At minimum: 1 single (leading edge) + 1 batch call for the rest
      expect(singleCalls + batchCalls).toBeGreaterThanOrEqual(1);
      // Total annotations processed = single calls + sum of batch sizes
      const batchSizes = (graphDb.createAnnotations as ReturnType<typeof vi.fn>).mock.calls
        .map((call: any[]) => (call[0] as any[]).length);
      const totalProcessed = singleCalls + batchSizes.reduce((a: number, b: number) => a + b, 0);
      expect(totalProcessed).toBe(5);
    });
  });

  describe('lifecycle', () => {
    it('should unsubscribe on stop', async () => {
      const localGraphDb = createMockGraphDb();
      const localWorkerBus = workerBusOverEventBus(coreEventBus);
      const localUnit = createWeaverActorStateUnit({ bus: localWorkerBus });
      const localConsumer = new Weaver(
        localGraphDb,
        localUnit.events$,
        localUnit.rebuilds$,
        asBusRequestPrimitive(coreEventBus),
        new FileWeaverCheckpoint(join(testDir, `weaver-checkpoint-${uuidv4()}.json`)),
        mockLogger,
      );
      await localConsumer.initialize();
      localUnit.start();

      const docId = resourceId(`lifecycle-stop-${Date.now()}`);

      // Verify events are received before stop
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Before Stop', format: 'text/plain', contentChecksum: 'h1' },
      });
      await tick();
      expect(localGraphDb.createResource).toHaveBeenCalledTimes(1);

      // Stop consumer
      await localConsumer.stop();
      vi.clearAllMocks();

      // Events after stop should not be processed
      const docId2 = resourceId(`lifecycle-after-stop-${Date.now()}`);
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: docId2,
        userId: userId('user1'),
        version: 1,
        payload: { name: 'After Stop', format: 'text/plain', contentChecksum: 'h2' },
      });
      await tick();

      expect(localGraphDb.createResource).not.toHaveBeenCalled();
    });

    it('should report health metrics', async () => {
      const metrics = consumer.getHealthMetrics();

      expect(metrics.subscriptions).toBe(1); // One injected source stream — channel fan-in (9) lives in WeaverActorStateUnit
      expect(metrics.pipelineActive).toBe(true);
      // A count, deliberately not the map — the full per-resource map made
      // /health an O(resources) payload (#845 scalability wart).
      expect(typeof metrics.resourcesTracked).toBe('number');
    });
  });

  describe('duplicate-delivery idempotency (WEAVER-ISOLATION P1)', () => {
    // At-least-once delivery (SSE reconnect with Last-Event-ID replay after
    // the split) means every fold must tolerate the same StoredEvent arriving
    // twice. These specs push identical events straight onto the bus — the
    // redelivery shape — against a REAL memory graph so state, not call
    // counts alone, is the oracle.
    let seq = 0;
    const nextSeq = () => ++seq;

    const stored = (type: string, rid: string | undefined, payload: unknown): StoredEvent => ({
      id: uuidv4(),
      type,
      timestamp: new Date().toISOString(),
      userId: userId('user-dup'),
      ...(rid ? { resourceId: resourceId(rid) } : {}),
      version: 1,
      payload,
      metadata: { sequenceNumber: nextSeq() },
    } as unknown as StoredEvent);

    const deliver = async (e: StoredEvent) => {
      coreEventBus.getDomainEvent(e.type as Parameters<EventBus['getDomainEvent']>[0]).next(e);
      await tick();
    };

    const createdEvent = (rid: string) =>
      stored('yield:created', rid, { name: 'Dup Test', format: 'text/plain', contentChecksum: 'h-dup' });

    const annotation = (aid: string, rid: string) => ({
      id: annotationId(aid),
      motivation: 'commenting',
      target: { source: rid },
      body: [],
    });

    beforeEach(async () => {
      // Swap the outer mock-based consumer for one wired to a real memory
      // graph — the outer afterEach still stops whatever `consumer` and
      // `weaverUnit` hold.
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);
    });

    it('yield:created twice → one resource', async () => {
      const e = createdEvent('dup-created');
      await deliver(e);
      await deliver(e);

      const { total } = await graphDb.listResources({});
      expect(total).toBe(1);
    });

    it('mark:added twice (sequential redelivery) → one annotation, under the event\'s own id, one create call', async () => {
      await deliver(createdEvent('dup-add'));
      const createSpy = vi.spyOn(graphDb, 'createAnnotation');

      const e = stored('mark:added', 'dup-add', { annotation: annotation('ann-dup-1', 'dup-add') });
      await deliver(e);
      await deliver(e);

      const { annotations } = await graphDb.listAnnotations({ resourceId: resourceId('dup-add') });
      expect(annotations).toHaveLength(1);
      // The graph must store the annotation under the event's id — the id is
      // the system of record's, not the store's to mint (Neo4j already
      // honors this; the fold and every backend must agree).
      expect(String(annotations[0]!.id)).toBe('ann-dup-1');
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('mark:added duplicated within one burst (batch path) → one annotation, one created input', async () => {
      await deliver(createdEvent('dup-add-burst'));
      const singleSpy = vi.spyOn(graphDb, 'createAnnotation');
      const batchSpy = vi.spyOn(graphDb, 'createAnnotations');

      const e = stored('mark:added', 'dup-add-burst', { annotation: annotation('ann-dup-burst', 'dup-add-burst') });
      // Same event twice in the same burst window — no tick between.
      coreEventBus.getDomainEvent('mark:added').next(e);
      coreEventBus.getDomainEvent('mark:added').next(e);
      await tick();

      const { annotations } = await graphDb.listAnnotations({ resourceId: resourceId('dup-add-burst') });
      expect(annotations).toHaveLength(1);
      const createdInputs =
        singleSpy.mock.calls.length +
        batchSpy.mock.calls.reduce((n, [inputs]) => n + inputs.length, 0);
      expect(createdInputs).toBe(1);
    });

    it('mark:removed twice → annotation gone, second delivery inert', async () => {
      await deliver(createdEvent('dup-rm'));
      await deliver(stored('mark:added', 'dup-rm', { annotation: annotation('ann-dup-rm', 'dup-rm') }));

      const e = stored('mark:removed', 'dup-rm', { annotationId: 'ann-dup-rm' });
      await deliver(e);
      await deliver(e);

      const { annotations } = await graphDb.listAnnotations({ resourceId: resourceId('dup-rm') });
      expect(annotations).toHaveLength(0);
    });

    it('mark:archived twice → archived once, still one resource', async () => {
      await deliver(createdEvent('dup-arch'));

      const e = stored('mark:archived', 'dup-arch', {});
      await deliver(e);
      await deliver(e);

      const doc = await graphDb.getResource(resourceId('dup-arch'));
      expect(doc?.archived).toBe(true);
      const { total } = await graphDb.listResources({});
      expect(total).toBe(1);
    });

    it('mark:unarchived twice → unarchived, stable', async () => {
      await deliver(createdEvent('dup-unarch'));
      await deliver(stored('mark:archived', 'dup-unarch', {}));

      const e = stored('mark:unarchived', 'dup-unarch', {});
      await deliver(e);
      await deliver(e);

      const doc = await graphDb.getResource(resourceId('dup-unarch'));
      expect(doc?.archived).toBe(false);
    });

    it('mark:body-updated (add op) twice → body item added once', async () => {
      await deliver(createdEvent('dup-body'));
      await deliver(stored('mark:added', 'dup-body', { annotation: annotation('ann-dup-body', 'dup-body') }));

      const item = { type: 'TextualBody', value: 'dup-comment', purpose: 'commenting' };
      const e = stored('mark:body-updated', 'dup-body', {
        annotationId: 'ann-dup-body',
        operations: [{ op: 'add', item }],
      });
      await deliver(e);
      await deliver(e);

      const ann = await graphDb.getAnnotation(annotationId('ann-dup-body'));
      const body = Array.isArray(ann?.body) ? ann.body : ann?.body ? [ann.body] : [];
      expect(body).toHaveLength(1);
    });

    it('mark:entity-tag-added twice → tag applied once (#974 pin)', async () => {
      await deliver(createdEvent('dup-tag'));

      const e = stored('mark:entity-tag-added', 'dup-tag', { entityType: 'DupTag' });
      await deliver(e);
      await deliver(e);

      const doc = await graphDb.getResource(resourceId('dup-tag'));
      expect(doc?.entityTypes).toEqual(['DupTag']);
    });

    it('mark:entity-tag-removed twice → tag gone, second delivery inert', async () => {
      await deliver(createdEvent('dup-untag'));
      await deliver(stored('mark:entity-tag-added', 'dup-untag', { entityType: 'DupTag' }));

      const e = stored('mark:entity-tag-removed', 'dup-untag', { entityType: 'DupTag' });
      await deliver(e);
      await deliver(e);

      const doc = await graphDb.getResource(resourceId('dup-untag'));
      expect(doc?.entityTypes).toEqual([]);
    });

    it('frame:entity-type-added twice → one registry entry', async () => {
      const e = stored('frame:entity-type-added', undefined, { entityType: 'DupEntityType' });
      await deliver(e);
      await deliver(e);

      const types = await graphDb.getEntityTypes();
      expect(types.filter((t) => t === 'DupEntityType')).toHaveLength(1);
    });
  });

  describe('checkpointed catch-up + weave:rebuild (WEAVER-ISOLATION P3)', () => {
    // Catch-up rides EXISTING read channels: resources discovered via
    // browse:resources-requested, gap events fetched via
    // browse:events-requested (full StoredEvents), filtered client-side by
    // the persisted checkpoint, then pushed through the normal pipeline —
    // per-resource lanes serialize against live traffic, idempotent folds
    // absorb overlap, and noteApplied signals fire during replay so the
    // whenApplied barrier keeps working mid-recovery.
    it('replays events missed while down, then a second catch-up is a checkpointed no-op', async () => {
      // Down: stop the live weaver, then append events nobody hears.
      await consumer.stop();
      weaverUnit.dispose();

      const rid = `catchup-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Missed While Down', format: 'text/plain', contentChecksum: 'h-cu' },
      });
      await eventStore.appendEvent({
        type: 'mark:archived',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: {},
      });

      // Back up: wire a fresh weaver on a real graph, live first, then catch up.
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);
      serveBrowseReads([rid]);

      const summary = await consumer.catchUp();

      const doc = await graphDb.getResource(resourceId(rid));
      expect(doc?.name).toBe('Missed While Down');
      expect(doc?.archived).toBe(true);
      expect(summary.eventsReplayed).toBeGreaterThanOrEqual(2);

      // Second pass: the checkpoint covers everything — nothing replays.
      const createSpy = vi.spyOn(graphDb, 'createResource');
      const summary2 = await consumer.catchUp();
      expect(summary2.eventsReplayed).toBe(0);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('a rewound log (restore) triggers a per-resource rebuild instead of trusting the checkpoint', async () => {
      await consumer.stop();
      weaverUnit.dispose();

      const rid = `rewound-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Restored', format: 'text/plain', contentChecksum: 'h-rw' },
      });

      // A checkpoint claiming we are FAR ahead of the log — the restore shape.
      const checkpointPath = join(testDir, `weaver-checkpoint-${uuidv4()}.json`);
      await new FileWeaverCheckpoint(checkpointPath).save({ [rid]: 999 });

      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb, checkpointPath);
      serveBrowseReads([rid]);

      const summary = await consumer.catchUp();

      expect((await graphDb.getResource(resourceId(rid)))?.name).toBe('Restored');
      expect(summary.resourcesRebuilt).toBe(1);
    });

    it('weave:rebuild (full) clears and rebuilds the graph, replying ok', async () => {
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);

      const rid = `rebuild-full-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Rebuilt', format: 'text/plain', contentChecksum: 'h-rb' },
      });
      await tick();

      // Rebuild reads history over the bus — the Weaver has no event-store
      // attachment (P4); these responders are its only view of the log.
      serveBrowseReads([rid]);
      const clearSpy = vi.spyOn(graphDb, 'clearDatabase');
      await busRequest(asBusRequestPrimitive(coreEventBus), 'weave:rebuild', {});

      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect((await graphDb.getResource(resourceId(rid)))?.name).toBe('Rebuilt');
    });

    it('weave:rebuild scoped to a resource rebuilds just that resource', async () => {
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);

      const rid = `rebuild-one-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Rebuilt One', format: 'text/plain', contentChecksum: 'h-r1' },
      });
      await tick();

      serveBrowseReads([rid]);
      const deleteSpy = vi.spyOn(graphDb, 'deleteResource');
      const clearSpy = vi.spyOn(graphDb, 'clearDatabase');
      await busRequest(asBusRequestPrimitive(coreEventBus), 'weave:rebuild', { resourceId: rid });

      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).not.toHaveBeenCalled();
      expect((await graphDb.getResource(resourceId(rid)))?.name).toBe('Rebuilt One');
    });
  });

  describe('completeness accounting + reconcile (#845)', () => {
    // The projection must never silently under-materialize: witnessed apply
    // failures are counted and hold the checkpoint back (so catch-up
    // revisits them), rebuilds that dropped events reply FAILED instead of
    // ok, and reconcile() backstops the failures nothing witnessed —
    // out-of-band graph mutations, wiped volumes, historical damage.

    it('a failed apply counts, does not advance lastProcessed, and emits no weave:applied', async () => {
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);

      const signals: string[] = [];
      const signalSub = coreEventBus.get('weave:applied').subscribe((s) => signals.push(s.resourceId));

      vi.spyOn(graphDb, 'createResource').mockRejectedValueOnce(new Error('neo4j hiccup'));

      const rid = `acct-fail-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Dropped', format: 'text/plain', contentChecksum: 'h-af' },
      });
      await tick();
      signalSub.unsubscribe();

      expect(consumer.appliedUpTo(rid)).toBeUndefined();
      expect(consumer.getHealthMetrics().applyFailures).toBeGreaterThanOrEqual(1);
      expect(signals).not.toContain(rid);
    });

    it('a failed batch run blocks checkpoint advance for the whole batch', async () => {
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);

      const rid = `acct-batch-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Batch Base', format: 'text/plain', contentChecksum: 'h-ab' },
      });
      await tick();
      const seqAfterCreate = consumer.appliedUpTo(rid);
      expect(seqAfterCreate).toBeDefined();

      vi.spyOn(graphDb, 'createAnnotations').mockRejectedValueOnce(new Error('neo4j hiccup'));

      // Three annotations back-to-back: burst passthrough applies the first
      // singly, then the remaining two flush as one batched run through
      // createAnnotations — the mocked failure.
      const ann = (aid: string) => ({
        id: annotationId(aid), motivation: 'commenting', target: { source: rid }, body: [],
      });
      const pushMark = (aid: string, seq: number) => coreEventBus.getDomainEvent('mark:added').next({
        id: uuidv4(), type: 'mark:added', timestamp: new Date().toISOString(),
        userId: userId('user1'), resourceId: resourceId(rid), version: 1,
        payload: { annotation: ann(aid) }, metadata: { sequenceNumber: seq },
      } as unknown as StoredEvent);
      pushMark('ann-b1', 2);
      pushMark('ann-b2', 3);
      pushMark('ann-b3', 4);
      await tick();

      // The passthrough single advanced to 2 (honest); the batched run
      // failed — the checkpoint must stop THERE, never skipping to 4, so
      // catch-up revisits the dropped events.
      expect(consumer.appliedUpTo(rid)).toBe(2);
    });

    it('weave:rebuild replies FAILED, not ok, when applies dropped events', async () => {
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);

      const rid = `acct-rebuild-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Will Drop', format: 'text/plain', contentChecksum: 'h-ar' },
      });
      await tick();

      serveBrowseReads([rid]);
      vi.spyOn(graphDb, 'createResource').mockRejectedValue(new Error('neo4j down'));

      await expect(
        busRequest(asBusRequestPrimitive(coreEventBus), 'weave:rebuild', {}),
      ).rejects.toThrow();
    });

    it('catch-up reports failures, holds the checkpoint, and the next pass re-replays', async () => {
      await consumer.stop();
      weaverUnit.dispose();

      const rid = `acct-catchup-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Retry Me', format: 'text/plain', contentChecksum: 'h-ac' },
      });

      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);
      serveBrowseReads([rid]);

      // First pass: the store hiccups once — the event is counted as failed
      // and the checkpoint must NOT advance past it.
      vi.spyOn(graphDb, 'createResource').mockRejectedValueOnce(new Error('neo4j hiccup'));
      const first = await consumer.catchUp();
      expect(first.eventsFailed).toBeGreaterThanOrEqual(1);
      expect(await graphDb.getResource(resourceId(rid))).toBeNull();

      // Second pass: the store is healthy — the held-back event replays.
      const second = await consumer.catchUp();
      expect(second.eventsReplayed).toBeGreaterThanOrEqual(1);
      expect((await graphDb.getResource(resourceId(rid)))?.name).toBe('Retry Me');
    });

    it('reconcile detects an out-of-band deletion and heals it from the log', async () => {
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);

      const rid = `rec-heal-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Healed', format: 'text/plain', contentChecksum: 'h-rh' },
      });
      await tick();
      expect((await graphDb.getResource(resourceId(rid)))?.name).toBe('Healed');

      // Out-of-band mutation: nothing the Weaver witnesses. The checkpoint
      // says "applied"; only a state diff can notice.
      await graphDb.deleteResource(resourceId(rid));

      serveBrowseReads([rid]);
      const summary = await consumer.reconcile();

      expect(summary.divergent).toBe(1);
      expect(summary.healed).toBe(1);
      expect((await graphDb.getResource(resourceId(rid)))?.name).toBe('Healed');
    });

    it('a clean graph reconciles with zero divergence and no heals', async () => {
      await consumer.stop();
      weaverUnit.dispose();
      graphDb = new MemoryGraphDatabase();
      consumer = await wireWeaver(graphDb);

      const rid = `rec-clean-${Date.now()}`;
      await eventStore.appendEvent({
        type: 'yield:created',
        resourceId: resourceId(rid),
        userId: userId('user1'),
        version: 1,
        payload: { name: 'Clean', format: 'text/plain', contentChecksum: 'h-rc' },
      });
      await tick();

      serveBrowseReads([rid]);
      const deleteSpy = vi.spyOn(graphDb, 'deleteResource');
      const summary = await consumer.reconcile();

      expect(summary.resourcesChecked).toBe(1);
      expect(summary.divergent).toBe(0);
      expect(summary.healed).toBe(0);
      expect(deleteSpy).not.toHaveBeenCalled();
    });
  });
});
