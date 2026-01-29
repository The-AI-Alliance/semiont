/**
 * ViewManager Tests
 * Tests for materialized view management wrapper layer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ViewManager } from '../view-manager';
import type { ViewStorage, ResourceView } from '../storage/view-storage';
import { resourceId, userId } from '@semiont/core';
import type { StoredEvent } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ViewManager', () => {
  let manager: ViewManager;
  let mockViewStorage: ViewStorage;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-viewmanager-${Date.now()}`);
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
      backendUrl: 'http://localhost:4000',
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
        type: 'resource.created' as const,
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
        metadata: {
          sequenceNumber: 1,
          previousHash: null,
          eventHash: 'hash1',
        },
      }]);

      await manager.materializeResource(rid, event, getAllEvents);

      // Should call save on view storage
      expect(mockViewStorage.save).toHaveBeenCalled();
    });

    it('should use getAllEvents for rebuild if view does not exist', async () => {
      const rid = resourceId('doc1');
      const event = {
        id: 'event1',
        type: 'representation.added' as const,
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
          event: {
            id: 'event0',
            type: 'resource.created' as const,
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
          },
          metadata: { sequenceNumber: 1, previousHash: null, eventHash: 'hash0' },
        },
        {
          event,
          metadata: { sequenceNumber: 2, previousHash: 'hash0', eventHash: 'hash1' },
        },
      ]);

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

      await manager.materializeSystem('entitytype.added', payload);

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
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: {
            sequenceNumber: 1,
            previousHash: null,
            eventHash: 'hash1',
          },
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
          '@id': 'http://localhost:4000/resources/doc1',
          name: 'Test',
          format: 'text/plain',
          representations: [],
        },
        annotations: {
          annotations: [],
          total: 0,
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
        type: 'resource.created' as const,
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
        metadata: { sequenceNumber: 1, previousHash: null, eventHash: 'hash1' },
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

      await manager.materializeSystem('entitytype.added', payload);

      expect(materializeEntityTypesSpy).toHaveBeenCalledWith(entityType);
    });
  });
});
