/**
 * Layered Storage Tests
 * Tests for Layer 1 (documents) and Layer 3 (projections) filesystem storage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FilesystemStorage } from '../../storage/filesystem';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import { EventStore } from '../../events/event-store';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DocumentProjection } from '@semiont/core-types';

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
      const projection: DocumentProjection = {
        id: docId,
        name: 'Test Doc',
        contentType: 'text/plain',
        metadata: {},
        entityTypes: ['note'],
        highlights: [],
        references: [],
        archived: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        creationMethod: 'API',
        createdBy: 'did:web:test.com:users:test',
      };

      await projectionStorage.saveProjection(docId, projection);

      // Verify file was created in correct shard
      const exists = await projectionStorage.projectionExists(docId);
      expect(exists).toBe(true);
    });

    it('should save and retrieve projections', async () => {
      const docId = 'doc-sha256:proj1';
      const projection: DocumentProjection = {
        id: docId,
        name: 'Projection Test',
        contentType: 'text/markdown',
        metadata: {},
        entityTypes: ['article', 'research'],
        highlights: [
          { id: 'hl1', text: 'important', position: { offset: 0, length: 9 } },
        ],
        references: [],
        archived: false,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
        version: 2,
        creationMethod: 'API',
        createdBy: 'did:web:test.com:users:test',
      };

      await projectionStorage.saveProjection(docId, projection);
      const retrieved = await projectionStorage.getProjection(docId);

      expect(retrieved).toEqual(projection);
    });

    it('should return null for non-existent projection', async () => {
      const result = await projectionStorage.getProjection('doc-sha256:nonexistent');
      expect(result).toBeNull();
    });

    it('should delete projections', async () => {
      const docId = 'doc-sha256:delete-me';
      const projection: DocumentProjection = {
        id: docId,
        name: 'To Delete',
        contentType: 'text/plain',
        metadata: {},
        entityTypes: [],
        highlights: [],
        references: [],
        archived: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        creationMethod: 'API',
        createdBy: 'did:web:test.com:users:test',
      };

      await projectionStorage.saveProjection(docId, projection);
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
          contentType: 'text/plain',
          contentHash: 'hash1',
        },
      });

      // Projection should be saved to Layer 3
      const stored = await projectionStorage.getProjection(docId);
      expect(stored).toBeDefined();
      expect(stored!.name).toBe('Integration Test');
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
          contentType: 'text/plain',
          contentHash: 'hash2',
        },
      });

      const before = await projectionStorage.getProjection(docId);
      expect(before!.highlights).toHaveLength(0);

      // Add highlight
      await eventStore.appendEvent({
        type: 'highlight.added',
        documentId: docId,
        userId: 'user1',
        version: 1,
        payload: {
          highlightId: 'hl1',
          text: 'Test highlight',
          position: { offset: 0, length: 14 },
        },
      });

      // Projection should be updated
      const after = await projectionStorage.getProjection(docId);
      expect(after!.highlights).toHaveLength(1);
      expect(after!.highlights[0]?.id).toBe('hl1');
      expect(after!.version).toBe(2);
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
          contentType: 'text/plain',
          contentHash: 'hash3',
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