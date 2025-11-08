/**
 * Layered Storage Tests
 * Tests for Layer 1 (resources) and Layer 3 (projections) filesystem storage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FilesystemStorage } from '../../storage/filesystem';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import { EventStore } from '../../events/event-store';
import type { IdentifierConfig } from '../../services/identifier-service';
import { EventQuery } from '../../events/query/event-query';
import { CREATION_METHODS } from '@semiont/core';
import { resourceId, userId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestResource } from '../fixtures/resource-fixtures';

describe('Layered Storage', () => {
  let testDir: string;
  let resourceStorage: FilesystemStorage;
  let projectionStorage: FilesystemProjectionStorage;
  let eventStore: EventStore;
  let query: EventQuery;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-layered-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    resourceStorage = new FilesystemStorage(testDir);
    projectionStorage = new FilesystemProjectionStorage(testDir);
    const identifierConfig: IdentifierConfig = { baseUrl: 'http://localhost:4000' };

    eventStore = new EventStore(
      {
        basePath: testDir,
        dataDir: testDir,
        enableSharding: true,
        maxEventsPerFile: 100,
      },
      projectionStorage,
      identifierConfig
    );

    query = new EventQuery(eventStore.log.storage);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Layer 1: Resource Storage', () => {
    it('should use 4-hex sharding for resources', async () => {
      const docId = resourceId('doc-sha256:abc123def456');
      const path = resourceStorage.getResourcePath(docId);

      // Should match pattern: resources/ab/cd/doc-sha256:abc123def456.dat
      expect(path).toMatch(/resources\/[0-9a-f]{2}\/[0-9a-f]{2}\/doc-sha256:abc123def456\.dat$/);
    });

    it('should save and retrieve resource content', async () => {
      const docId = resourceId('doc-sha256:test1');
      const content = 'This is test resource content';

      await resourceStorage.saveResource(docId, content);
      const retrieved = await resourceStorage.getResource(docId);

      expect(retrieved.toString('utf-8')).toBe(content);
    });

    it('should handle binary content', async () => {
      const docId = resourceId('doc-sha256:test2');
      const content = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await resourceStorage.saveResource(docId, content);
      const retrieved = await resourceStorage.getResource(docId);

      expect(retrieved).toEqual(content);
    });
  });

  describe('Layer 3: Projection Storage', () => {
    it('should use 4-hex sharding for projections', async () => {
      const docId = resourceId('doc-sha256:xyz789');
      const stored = {
        resource: createTestResource({
          '@id': `urn:semiont:resource:${docId}`,
          name: 'Test Doc',
          representations: [{
            mediaType: 'text/plain',
            checksum: 'test-checksum',
            rel: 'original',
          }],
          entityTypes: ['note'],
          archived: false,
          dateCreated: new Date().toISOString(),
          creationMethod: 'api',
          wasAttributedTo: {
            name: 'Test User',
          },
        }),
        annotations: {
          resourceId: docId,
          annotations: [],
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      };

      await projectionStorage.save(docId, stored);

      // Verify file was created in correct shard
      const exists = await projectionStorage.exists(docId);
      expect(exists).toBe(true);
    });

    it('should save and retrieve projections', async () => {
      const docId = resourceId('doc-sha256:proj1');
      const stored = {
        resource: createTestResource({
          '@id': `urn:semiont:resource:${docId}`,
          name: 'Projection Test',
          representations: [{
            mediaType: 'text/markdown',
            checksum: 'test-checksum',
            rel: 'original',
          }],
          entityTypes: ['article', 'research'],
          archived: false,
          dateCreated: '2025-01-01T00:00:00Z',
          creationMethod: 'api',
          wasAttributedTo: {
            name: 'Test User',
          },
        }),
        annotations: {
          resourceId: docId,
          annotations: [
            {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              'type': 'Annotation' as const,
              id: 'hl1',
              motivation: 'highlighting' as const,
              target: {
                source: docId,
                selector: [
                  {
                    type: 'TextPositionSelector' as const,
                    start: 0,
                    end: 9,
                  },
                  {
                    type: 'TextQuoteSelector' as const,
                    exact: 'important',
                  },
                ],
              },
              body: [], // Empty body array (no entity tags)
              creator: {
                type: 'Person' as const,
                id: 'did:web:test.com:users:test',
                name: 'test',
              },
              created: '2025-01-01T00:00:00.000Z',
            },
          ],
          version: 2,
          updatedAt: '2025-01-01T00:00:00Z',
        },
      };

      await projectionStorage.save(docId, stored);
      const retrieved = await projectionStorage.get(docId);

      expect(retrieved).toEqual(stored);
    });

    it('should return null for non-existent projection', async () => {
      const result = await projectionStorage.get(resourceId('doc-sha256:nonexistent'));
      expect(result).toBeNull();
    });

    it('should delete projections', async () => {
      const docId = resourceId('doc-sha256:delete-me');
      const stored = {
        resource: createTestResource({
          '@id': `urn:semiont:resource:${docId}`,
          name: 'To Delete',
          representations: [{
            mediaType: 'text/plain',
            checksum: 'test-checksum',
            rel: 'original',
          }],
          entityTypes: [],
          archived: false,
          dateCreated: new Date().toISOString(),
          creationMethod: 'api',
          wasAttributedTo: {
            name: 'Test User',
          },
        }),
        annotations: {
          resourceId: docId,
          annotations: [],
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      };

      await projectionStorage.save(docId, stored);
      expect(await projectionStorage.exists(docId)).toBe(true);

      await projectionStorage.delete(docId);
      expect(await projectionStorage.exists(docId)).toBe(false);
    });
  });

  describe('Event Store Integration', () => {
    it('should save projections when rebuilding from events', async () => {
      const docId = resourceId('doc-test-integration1');

      // Emit resource.created event
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          name: 'Integration Test',
          format: 'text/plain' as const,
          contentChecksum: 'hash1',
          creationMethod: CREATION_METHODS.API,
        },
      });

      // Projection should be saved to Layer 3
      const stored = await projectionStorage.get(docId);
      expect(stored).toBeDefined();
      expect(stored!.resource.name).toBe('Integration Test');
    });

    it('should update projections when events appended', async () => {
      const docId = resourceId('doc-test-integration2');

      // Create resource
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          name: 'Update Test',
          format: 'text/plain' as const,
          contentChecksum: 'hash2',
          creationMethod: CREATION_METHODS.API,
        },
      });

      const before = await projectionStorage.get(docId);
      expect(before!.annotations.annotations).toHaveLength(0);

      // Add highlighting annotation
      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          annotation: {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            'type': 'Annotation' as const,
            id: 'hl1',
            motivation: 'highlighting' as const,
            target: {
              source: docId,
              selector: [
                {
                  type: 'TextPositionSelector',
                  start: 0,
                  end: 14,
                },
                {
                  type: 'TextQuoteSelector',
                  exact: 'Test highlight',
                },
              ],
            },
            body: [], // Empty body array (no entity tags)
            modified: new Date().toISOString(),
          },
        },
      });

      // Projection should be updated
      const after = await projectionStorage.get(docId);
      expect(after!.annotations.annotations).toHaveLength(1);
      expect(after!.annotations.annotations[0]?.id).toBe('hl1');
      expect(after!.annotations.version).toBe(2);
    });

    it('should load from Layer 3 when projection exists', async () => {
      const docId = resourceId('doc-test-integration3');

      // Create events
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          name: 'Load Test',
          format: 'text/plain' as const,
          contentChecksum: 'hash3',
          creationMethod: CREATION_METHODS.API,
        },
      });

      // First call rebuilds from events
      const events1 = await query.getResourceEvents(docId);
      const projection1 = await eventStore.projections.projector.projectResource(events1, docId);

      // Second call should load from Layer 3 (no rebuild)
      const events2 = await query.getResourceEvents(docId);
      const projection2 = await eventStore.projections.projector.projectResource(events2, docId);

      expect(projection1).toEqual(projection2);
    });
  });
});