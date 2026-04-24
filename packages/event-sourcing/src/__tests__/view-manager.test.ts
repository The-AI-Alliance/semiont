/**
 * ViewManager Tests
 * Tests for materialized view management wrapper layer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ViewManager } from '../view-manager';
import type { ViewStorage, ResourceView } from '../storage/view-storage';
import { resourceId, userId } from '@semiont/core';
import type { EventMetadata } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Helper to create minimal EventMetadata for tests
function createEventMetadata(sequenceNumber: number): EventMetadata {
  return {
    sequenceNumber,
    streamPosition: sequenceNumber * 100,
  };
}

describe('ViewManager', () => {
  let manager: ViewManager;
  let mockViewStorage: ViewStorage;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-viewmanager-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create mock view storage
    mockViewStorage = {
      get: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([]),
      exists: vi.fn().mockResolvedValue(false),
    };

    manager = new ViewManager(mockViewStorage, {
      basePath: testDir,
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Constructor', () => {
    it('should create ViewManager with storage and config', () => {
      expect(manager).toBeDefined();
      expect(manager.materializer).toBeDefined();
    });
  });

  describe('materializeResource()', () => {
    it('should update resource view with new event', async () => {
      const rid = resourceId('doc1');
      const event = {
        id: 'event1',
        type: 'yield:created' as const,
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        resourceId: rid,
        version: 1,
        payload: {
          name: 'Test Document',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      };

      const getAllEvents = vi.fn().mockResolvedValue([{
        event,
        metadata: createEventMetadata(1),
      }]);

      await manager.materializeResource(rid, event, getAllEvents);

      // Should call save on view storage
      expect(mockViewStorage.save).toHaveBeenCalled();
    });

    it('should use getAllEvents for rebuild if view does not exist', async () => {
      const rid = resourceId('doc1');
      const event = {
        id: 'event1',
        type: 'yield:representation-added' as const,
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        resourceId: rid,
        version: 1,
        payload: {
          representation: {
            '@id': 'checksum1',
            mediaType: 'text/plain',
            byteSize: 100,
            checksum: 'checksum1',
            created: new Date().toISOString(),
          },
        },
      };

      const getAllEvents = vi.fn().mockResolvedValue([
        {
            id: 'event0',
            type: 'yield:created' as const,
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },
            metadata: createEventMetadata(1),
        },
        {
          ...event,
          metadata: createEventMetadata(2),
        },
      ] as any);

      await manager.materializeResource(rid, event, getAllEvents);

      expect(getAllEvents).toHaveBeenCalled();
      expect(mockViewStorage.save).toHaveBeenCalled();
    });
  });

  describe('materializeSystem()', () => {
    it('should call materializer for entitytype.added events', async () => {
      const payload = {
        entityType: {
          '@id': 'http://example.com/entitytypes/Document',
          name: 'Document',
          description: 'A document entity type',
        },
      };

      // Spy on materializer method
      const materializeEntityTypesSpy = vi.spyOn(manager.materializer, 'materializeEntityTypes');

      await manager.materializeSystem('mark:entity-type-added', payload);

      expect(materializeEntityTypesSpy).toHaveBeenCalledWith(payload.entityType);
    });

    it('should ignore non-entitytype system events', async () => {
      const payload = { data: 'test' };

      // Spy on materializer method
      const materializeEntityTypesSpy = vi.spyOn(manager.materializer, 'materializeEntityTypes');

      await manager.materializeSystem('unknown.event', payload);

      // Should not call materializer for unknown events
      expect(materializeEntityTypesSpy).not.toHaveBeenCalled();
    });
  });

  describe('getOrMaterialize()', () => {
    it('should return null for empty event list', async () => {
      const rid = resourceId('doc1');
      const view = await manager.getOrMaterialize(rid, []);

      expect(view).toBeNull();
    });

    it('should materialize view from events if not cached', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {
            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },
            metadata: createEventMetadata(1),
        },
      ];

      const view = await manager.getOrMaterialize(rid, events);

      expect(view).not.toBeNull();
      expect(mockViewStorage.save).toHaveBeenCalled();
    });

    it('should return cached view if exists', async () => {
      const rid = resourceId('doc1');
      const cachedView: ResourceView = {
        resource: {
          '@context': 'https://www.w3.org/ns/activitystreams',
          '@id': rid,
          name: 'Test',
          format: 'text/plain',
          representations: [],
        },
        annotations: {
          resourceId: rid,
          version: 0,
          updatedAt: new Date().toISOString(),
          annotations: [],
        },
      };

      mockViewStorage.get = vi.fn().mockResolvedValue(cachedView);

      const view = await manager.getOrMaterialize(rid, []);

      expect(view).toEqual(cachedView);
      expect(mockViewStorage.get).toHaveBeenCalledWith(rid);
    });
  });

  describe('Integration with ViewMaterializer', () => {
    it('should delegate to materializer for incremental updates', async () => {
      const rid = resourceId('doc1');
      const event = {
        id: 'event1',
        type: 'yield:created' as const,
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        resourceId: rid,
        version: 1,
        payload: {
          name: 'Test',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      };

      const getAllEvents = vi.fn().mockResolvedValue([{
        event,
        metadata: createEventMetadata(1),
      }]);

      // Spy on materializer method
      const materializeIncrementalSpy = vi.spyOn(manager.materializer, 'materializeIncremental');

      await manager.materializeResource(rid, event, getAllEvents);

      expect(materializeIncrementalSpy).toHaveBeenCalledWith(rid, event, getAllEvents);
    });

    it('should delegate to materializer for entity types', async () => {
      const entityType = {
        '@id': 'http://example.com/entitytypes/Document',
        name: 'Document',
      };
      const payload = { entityType };

      const materializeEntityTypesSpy = vi.spyOn(manager.materializer, 'materializeEntityTypes');

      await manager.materializeSystem('mark:entity-type-added', payload);

      expect(materializeEntityTypesSpy).toHaveBeenCalledWith(entityType);
    });
  });

  describe('per-resource serialization', () => {
    // Build a minimal yield:created event for a given resource id
    const mkEvent = (rid: ReturnType<typeof resourceId>) => ({
      id: `event-${rid}`,
      type: 'yield:created' as const,
      timestamp: new Date().toISOString(),
      userId: userId('user1'),
      resourceId: rid,
      version: 1,
      payload: {
        name: 'Test',
        format: 'text/plain' as const,
        contentChecksum: 'cs',
        creationMethod: 'api' as const,
      },
    });

    it('serializes concurrent calls for the same resource', async () => {
      const rid = resourceId('doc1');
      const event = mkEvent(rid);
      const getAllEvents = vi.fn().mockResolvedValue([]);

      // Record the real-time interleaving of start/end events for each call.
      const trace: string[] = [];
      let callCount = 0;
      vi.spyOn(manager.materializer, 'materializeIncremental').mockImplementation(async () => {
        const n = ++callCount;
        trace.push(`start-${n}`);
        // Simulate an async read-modify-write cycle
        await new Promise((r) => setTimeout(r, 20));
        trace.push(`end-${n}`);
      });

      // Fire three calls at once, without awaiting between them
      await Promise.all([
        manager.materializeResource(rid, event, getAllEvents),
        manager.materializeResource(rid, event, getAllEvents),
        manager.materializeResource(rid, event, getAllEvents),
      ]);

      // If serialization works, starts and ends are strictly interleaved
      // per call: start-1, end-1, start-2, end-2, start-3, end-3.
      // If concurrent, we'd see start-1, start-2, start-3, end-*, end-*, end-*.
      expect(trace).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
    });

    it('runs calls for different resources in parallel', async () => {
      const rid1 = resourceId('doc1');
      const rid2 = resourceId('doc2');
      const getAllEvents = vi.fn().mockResolvedValue([]);

      const trace: string[] = [];
      vi.spyOn(manager.materializer, 'materializeIncremental').mockImplementation(async (rid) => {
        const tag = String(rid);
        trace.push(`start-${tag}`);
        await new Promise((r) => setTimeout(r, 20));
        trace.push(`end-${tag}`);
      });

      await Promise.all([
        manager.materializeResource(rid1, mkEvent(rid1), getAllEvents),
        manager.materializeResource(rid2, mkEvent(rid2), getAllEvents),
      ]);

      // Both should start before either ends — proves non-blocking across resources
      const starts = trace.filter((t) => t.startsWith('start-'));
      const firstEndIndex = trace.findIndex((t) => t.startsWith('end-'));
      expect(starts.length).toBe(2);
      expect(firstEndIndex).toBeGreaterThan(1); // both starts happened before any end
    });

    it('does not poison the chain when one call fails', async () => {
      const rid = resourceId('doc1');
      const event = mkEvent(rid);
      const getAllEvents = vi.fn().mockResolvedValue([]);

      let callCount = 0;
      vi.spyOn(manager.materializer, 'materializeIncremental').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('first call fails');
        // subsequent calls succeed
      });

      const results = await Promise.allSettled([
        manager.materializeResource(rid, event, getAllEvents),
        manager.materializeResource(rid, event, getAllEvents),
        manager.materializeResource(rid, event, getAllEvents),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(results[2].status).toBe('fulfilled');
      expect(callCount).toBe(3); // all three attempts ran
    });

    it('clears the chain entry when the last call completes', async () => {
      const rid = resourceId('doc1');
      const event = mkEvent(rid);
      const getAllEvents = vi.fn().mockResolvedValue([]);

      vi.spyOn(manager.materializer, 'materializeIncremental').mockResolvedValue(undefined);

      await manager.materializeResource(rid, event, getAllEvents);

      // Access private state via type assertion — test intent is explicit
      const chains = (manager as unknown as { resourceChains: Map<string, Promise<void>> }).resourceChains;
      expect(chains.has(String(rid))).toBe(false);
    });
  });
});
