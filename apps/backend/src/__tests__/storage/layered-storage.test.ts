/**
 * Layered Storage Tests
 * Tests for Layer 1 (documents) and Layer 3 (projections) filesystem storage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FilesystemStorage } from '../../storage/filesystem';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import { EventStore } from '../../events/event-store';
import { CREATION_METHODS } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Layered Storage', () => {
  let testDir: string;
  let documentStorage: FilesystemStorage;
  let projectionStorage: FilesystemProjectionStorage;
  let eventStore: EventStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-layered-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    documentStorage = new FilesystemStorage(testDir);
    projectionStorage = new FilesystemProjectionStorage(testDir);

    eventStore = new EventStore({
      dataDir: testDir,
      enableSharding: true,
      maxEventsPerFile: 100,
    }, projectionStorage);

    await eventStore.initialize();
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Layer 1: Document Storage', () => {
    it('should use 4-hex sharding for documents', async () => {
      const docId = 'doc-sha256:abc123def456';
      const path = documentStorage.getDocumentPath(docId);

      // Should match pattern: documents/ab/cd/doc-sha256:abc123def456.dat
      expect(path).toMatch(/documents\/[0-9a-f]{2}\/[0-9a-f]{2}\/doc-sha256:abc123def456\.dat$/);
    });

    it('should save and retrieve document content', async () => {
      const docId = 'doc-sha256:test1';
      const content = 'This is test document content';

      await documentStorage.saveDocument(docId, content);
      const retrieved = await documentStorage.getDocument(docId);

      expect(retrieved.toString('utf-8')).toBe(content);
    });

    it('should handle binary content', async () => {
      const docId = 'doc-sha256:test2';
      const content = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      await documentStorage.saveDocument(docId, content);
      const retrieved = await documentStorage.getDocument(docId);

      expect(retrieved).toEqual(content);
    });
  });

  describe('Layer 3: Projection Storage', () => {
    it('should use 4-hex sharding for projections', async () => {
      const docId = 'doc-sha256:xyz789';
      const stored = {
        document: {
          id: docId,
          name: 'Test Doc',
          format: 'text/plain' as const,
          metadata: {},
          entityTypes: ['note'],
          archived: false,
          created: new Date().toISOString(),
          contentChecksum: "test-checksum",
          creationMethod: 'api' as const,
          creator: {
            id: 'did:web:test.com:users:test',
            type: 'Person' as const,
            name: 'Test User',
          },
        },
        annotations: {
          documentId: docId,
          annotations: [],
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      };

      await projectionStorage.saveProjection(docId, stored);

      // Verify file was created in correct shard
      const exists = await projectionStorage.projectionExists(docId);
      expect(exists).toBe(true);
    });

    it('should save and retrieve projections', async () => {
      const docId = 'doc-sha256:proj1';
      const stored = {
        document: {
          id: docId,
          name: 'Projection Test',
          format: 'text/markdown' as const,
          metadata: {},
          entityTypes: ['article', 'research'],
          archived: false,
          created: '2025-01-01T00:00:00Z',
          contentChecksum: "test-checksum",
          creationMethod: 'api' as const,
          creator: {
            id: 'did:web:test.com:users:test',
            type: 'Person' as const,
            name: 'Test User',
          },
        },
        annotations: {
          documentId: docId,
          annotations: [
            {
              id: 'hl1',
              motivation: 'highlighting' as const,
              target: {
                source: docId,
                selector: {
                  type: 'TextPositionSelector' as const,
                  exact: 'important',
                  offset: 0,
                  length: 9,
                },
              },
              body: {
                type: 'TextualBody' as const,
                entityTypes: [],
              },
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

      await projectionStorage.saveProjection(docId, stored);
      const retrieved = await projectionStorage.getProjection(docId);

      expect(retrieved).toEqual(stored);
    });

    it('should return null for non-existent projection', async () => {
      const result = await projectionStorage.getProjection('doc-sha256:nonexistent');
      expect(result).toBeNull();
    });

    it('should delete projections', async () => {
      const docId = 'doc-sha256:delete-me';
      const stored = {
        document: {
          id: docId,
          name: 'To Delete',
          format: 'text/plain' as const,
          metadata: {},
          entityTypes: [],
          archived: false,
          created: new Date().toISOString(),
          contentChecksum: "test-checksum",
          creationMethod: 'api' as const,
          creator: {
            id: 'did:web:test.com:users:test',
            type: 'Person' as const,
            name: 'Test User',
          },
        },
        annotations: {
          documentId: docId,
          annotations: [],
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      };

      await projectionStorage.saveProjection(docId, stored);
      expect(await projectionStorage.projectionExists(docId)).toBe(true);

      await projectionStorage.deleteProjection(docId);
      expect(await projectionStorage.projectionExists(docId)).toBe(false);
    });
  });

  describe('Event Store Integration', () => {
    it('should save projections when rebuilding from events', async () => {
      const docId = 'doc-test-integration1';

      // Emit document.created event
      await eventStore.appendEvent({
        type: 'document.created',
        documentId: docId,
        userId: 'user1',
        version: 1,
        payload: {
          name: 'Integration Test',
          format: 'text/plain' as const,
          contentChecksum: 'hash1',
          creationMethod: CREATION_METHODS.API,
        },
      });

      // Projection should be saved to Layer 3
      const stored = await projectionStorage.getProjection(docId);
      expect(stored).toBeDefined();
      expect(stored!.document.name).toBe('Integration Test');
    });

    it('should update projections when events appended', async () => {
      const docId = 'doc-test-integration2';

      // Create document
      await eventStore.appendEvent({
        type: 'document.created',
        documentId: docId,
        userId: 'user1',
        version: 1,
        payload: {
          name: 'Update Test',
          format: 'text/plain' as const,
          contentChecksum: 'hash2',
          creationMethod: CREATION_METHODS.API,
        },
      });

      const before = await projectionStorage.getProjection(docId);
      expect(before!.annotations.annotations).toHaveLength(0);

      // Add highlighting annotation
      await eventStore.appendEvent({
        type: 'annotation.added',
        documentId: docId,
        userId: 'user1',
        version: 1,
        payload: {
          annotationId: 'hl1',
          motivation: 'highlighting',
          exact: 'Test highlight',
          position: { offset: 0, length: 14 },
        },
      });

      // Projection should be updated
      const after = await projectionStorage.getProjection(docId);
      expect(after!.annotations.annotations).toHaveLength(1);
      expect(after!.annotations.annotations[0]?.id).toBe('hl1');
      expect(after!.annotations.version).toBe(2);
    });

    it('should load from Layer 3 when projection exists', async () => {
      const docId = 'doc-test-integration3';

      // Create events
      await eventStore.appendEvent({
        type: 'document.created',
        documentId: docId,
        userId: 'user1',
        version: 1,
        payload: {
          name: 'Load Test',
          format: 'text/plain' as const,
          contentChecksum: 'hash3',
          creationMethod: CREATION_METHODS.API,
        },
      });

      // First call rebuilds from events
      const projection1 = await eventStore.projectDocument(docId);

      // Second call should load from Layer 3 (no rebuild)
      const projection2 = await eventStore.projectDocument(docId);

      expect(projection1).toEqual(projection2);
    });
  });
});