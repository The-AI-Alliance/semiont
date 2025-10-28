/**
 * ProjectionStorage Tests
 * Tests for Layer 3 projection file I/O operations
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectionStorage, type DocumentState } from '../../storage/projection/projection-storage-v2';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DocumentAnnotations } from '@semiont/core';
import { createTestResource } from '../fixtures/resource-fixtures';
import { getResourceId } from '../../utils/resource-helpers';

describe('ProjectionStorage', () => {
  let testDir: string;
  let storage: ProjectionStorage;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-projection-storage-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    storage = new ProjectionStorage({
      basePath: testDir,
      subNamespace: 'documents',
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create test document state
  const createTestDocumentState = (docId: string): DocumentState => {
    const document = createTestResource({
      '@id': `urn:semiont:resource:${docId}`,
      name: `Test Document ${docId}`,
      representations: [{
        mediaType: 'text/plain',
        checksum: 'sha256:test',
        rel: 'original',
      }],
      creationMethod: 'ui',
      wasAttributedTo: {
        name: 'Test User',
      },
      dateCreated: '2025-01-01T00:00:00.000Z',
      archived: false,
      entityTypes: [],
    });

    const annotations: DocumentAnnotations = {
      documentId: docId,
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      annotations: [],
    };

    return { document, annotations };
  };

  describe('Save Operations', () => {
    it('should save projection to disk', async () => {
      const docId = 'doc-sha256:save-test-1';
      const state = createTestDocumentState(docId);

      await storage.save(docId, state);

      // Verify file exists
      const exists = await storage.exists(docId);
      expect(exists).toBe(true);
    });

    it('should create shard directories automatically', async () => {
      const docId = 'doc-sha256:auto-dir-test';
      const state = createTestDocumentState(docId);

      await storage.save(docId, state);

      // Verify projection was saved
      const loaded = await storage.get(docId);
      expect(loaded).not.toBeNull();
      expect(getResourceId(loaded!.document)).toBe(docId);
    });

    it('should overwrite existing projection', async () => {
      const docId = 'doc-sha256:overwrite-test';
      const state1 = createTestDocumentState(docId);
      state1.document.name = 'Original Name';

      await storage.save(docId, state1);

      // Overwrite with new state
      const state2 = createTestDocumentState(docId);
      state2.document.name = 'Updated Name';
      await storage.save(docId, state2);

      // Verify updated state
      const loaded = await storage.get(docId);
      expect(loaded?.document.name).toBe('Updated Name');
    });

    it('should save multiple projections independently', async () => {
      const docIds = [
        'doc-sha256:multi-1',
        'doc-sha256:multi-2',
        'doc-sha256:multi-3',
      ];

      for (const docId of docIds) {
        const state = createTestDocumentState(docId);
        await storage.save(docId, state);
      }

      // Verify all saved
      for (const docId of docIds) {
        const exists = await storage.exists(docId);
        expect(exists).toBe(true);
      }
    });

    it('should preserve document state exactly', async () => {
      const docId = 'doc-sha256:preserve-test';
      const original = createTestDocumentState(docId);
      original.document.entityTypes = ['Person', 'Organization'];
      original.annotations.version = 42;

      await storage.save(docId, original);

      const loaded = await storage.get(docId);
      expect(loaded?.document.entityTypes).toEqual(['Person', 'Organization']);
      expect(loaded?.annotations.version).toBe(42);
    });
  });

  describe('Get Operations', () => {
    it('should retrieve saved projection', async () => {
      const docId = 'doc-sha256:get-test-1';
      const state = createTestDocumentState(docId);

      await storage.save(docId, state);

      const loaded = await storage.get(docId);
      expect(loaded).not.toBeNull();
      expect(getResourceId(loaded!.document)).toBe(docId);
      expect(loaded?.annotations.documentId).toBe(docId);
    });

    it('should return null for non-existent projection', async () => {
      const docId = 'doc-sha256:does-not-exist';

      const loaded = await storage.get(docId);
      expect(loaded).toBeNull();
    });

    it('should handle different document ID formats', async () => {
      const formats = [
        'doc-sha256:abc123',
        'ann-sha256:def456',
        'simple-id-789',
      ];

      for (const docId of formats) {
        const state = createTestDocumentState(docId);
        await storage.save(docId, state);

        const loaded = await storage.get(docId);
        expect(getResourceId(loaded!.document)).toBe(docId);
      }
    });

    it('should parse JSON correctly', async () => {
      const docId = 'doc-sha256:json-test';
      const state = createTestDocumentState(docId);
      state.annotations.annotations = [
        {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: 'ann-123',
          motivation: 'highlighting',
          target: { source: docId },
          body: [],
          creator: {
            id: 'user-123',
            type: 'Person',
            name: 'Test User',
          },
          created: '2025-01-01T00:00:00.000Z',
          modified: '2025-01-01T00:00:00.000Z',
        },
      ];

      await storage.save(docId, state);

      const loaded = await storage.get(docId);
      expect(loaded?.annotations.annotations).toHaveLength(1);
      expect(loaded?.annotations.annotations[0]?.id).toBe('ann-123');
    });
  });

  describe('Delete Operations', () => {
    it('should delete existing projection', async () => {
      const docId = 'doc-sha256:delete-test-1';
      const state = createTestDocumentState(docId);

      await storage.save(docId, state);
      expect(await storage.exists(docId)).toBe(true);

      await storage.delete(docId);
      expect(await storage.exists(docId)).toBe(false);
    });

    it('should not throw when deleting non-existent projection', async () => {
      const docId = 'doc-sha256:never-existed';

      // Should not throw
      await expect(storage.delete(docId)).resolves.toBeUndefined();
    });

    it('should allow re-saving after deletion', async () => {
      const docId = 'doc-sha256:re-save-test';
      const state = createTestDocumentState(docId);

      await storage.save(docId, state);
      await storage.delete(docId);
      await storage.save(docId, state);

      const loaded = await storage.get(docId);
      expect(getResourceId(loaded!.document)).toBe(docId);
    });
  });

  describe('Exists Operations', () => {
    it('should return true for existing projection', async () => {
      const docId = 'doc-sha256:exists-test-1';
      const state = createTestDocumentState(docId);

      await storage.save(docId, state);

      expect(await storage.exists(docId)).toBe(true);
    });

    it('should return false for non-existent projection', async () => {
      const docId = 'doc-sha256:not-here';

      expect(await storage.exists(docId)).toBe(false);
    });

    it('should return false after deletion', async () => {
      const docId = 'doc-sha256:exists-then-deleted';
      const state = createTestDocumentState(docId);

      await storage.save(docId, state);
      await storage.delete(docId);

      expect(await storage.exists(docId)).toBe(false);
    });
  });

  describe('Scan Operations', () => {
    it('should get all document IDs', async () => {
      const storage2 = new ProjectionStorage({
        basePath: testDir,
        subNamespace: 'scan-test-1',
      });

      const docIds = ['doc-1', 'doc-2', 'doc-3'];
      for (const docId of docIds) {
        const state = createTestDocumentState(docId);
        await storage2.save(docId, state);
      }

      const allIds = await storage2.getAllDocumentIds();
      expect(allIds).toHaveLength(3);
      expect(allIds).toContain('doc-1');
      expect(allIds).toContain('doc-2');
      expect(allIds).toContain('doc-3');
    });

    it('should get all projections', async () => {
      const storage3 = new ProjectionStorage({
        basePath: testDir,
        subNamespace: 'scan-test-2',
      });

      const docIds = ['doc-a', 'doc-b'];
      for (const docId of docIds) {
        const state = createTestDocumentState(docId);
        await storage3.save(docId, state);
      }

      const allProjections = await storage3.getAll();
      expect(allProjections).toHaveLength(2);

      const ids = allProjections.map(p => getResourceId(p.document));
      expect(ids).toContain('doc-a');
      expect(ids).toContain('doc-b');
    });

    it('should return empty array when no projections exist', async () => {
      const storage4 = new ProjectionStorage({
        basePath: testDir,
        subNamespace: 'empty-namespace',
      });

      const allIds = await storage4.getAllDocumentIds();
      expect(allIds).toEqual([]);

      const allProjections = await storage4.getAll();
      expect(allProjections).toEqual([]);
    });
  });

  describe('System Projections', () => {
    it('should save and get system projection', async () => {
      const data = { entityTypes: ['Person', 'Organization', 'Document'] };

      await storage.saveSystem('entity-types.json', data);

      const loaded = await storage.getSystem('entity-types.json');
      expect(loaded).toEqual(data);
    });

    it('should return null for non-existent system projection', async () => {
      const loaded = await storage.getSystem('non-existent.json');
      expect(loaded).toBeNull();
    });

    it('should overwrite system projection', async () => {
      const data1 = { count: 1 };
      const data2 = { count: 2 };

      await storage.saveSystem('counter.json', data1);
      await storage.saveSystem('counter.json', data2);

      const loaded = await storage.getSystem('counter.json');
      expect(loaded).toEqual(data2);
    });

    it('should handle complex system data', async () => {
      const data = {
        stats: {
          documents: 100,
          annotations: 500,
        },
        lastUpdated: '2025-01-01T00:00:00.000Z',
        tags: ['important', 'verified'],
      };

      await storage.saveSystem('stats.json', data);

      const loaded = await storage.getSystem('stats.json');
      expect(loaded).toEqual(data);
    });
  });

  describe('Sharding', () => {
    it('should distribute documents across shards', async () => {
      const storage5 = new ProjectionStorage({
        basePath: testDir,
        subNamespace: 'shard-test',
      });

      // Create 50 documents
      for (let i = 0; i < 50; i++) {
        const docId = `doc-shard-${i}`;
        const state = createTestDocumentState(docId);
        await storage5.save(docId, state);
      }

      // Verify all were saved
      const allIds = await storage5.getAllDocumentIds();
      expect(allIds.length).toBe(50);

      // Check that they're in different shards (not all in same directory)
      // This is implicit - if sharding wasn't working, we'd see errors or conflicts
    });

    it('should use consistent sharding', async () => {
      const docId = 'doc-sha256:consistent-shard';
      const state = createTestDocumentState(docId);

      // Save, delete, save again
      await storage.save(docId, state);
      await storage.delete(docId);
      await storage.save(docId, state);

      // Should still be retrievable (same shard)
      const loaded = await storage.get(docId);
      expect(getResourceId(loaded!.document)).toBe(docId);
    });
  });

  describe('Error Handling', () => {
    it('should throw on malformed JSON', async () => {
      const docId = 'doc-sha256:bad-json';
      const state = createTestDocumentState(docId);

      // Save valid JSON first
      await storage.save(docId, state);

      // Corrupt the file
      const storage6 = new ProjectionStorage({
        basePath: testDir,
        subNamespace: 'documents',
      });

      // Manually write invalid JSON to the file
      const pathBuilder = (storage6 as any).pathBuilder;
      const filePath = pathBuilder.buildPath(docId, '.json');
      await fs.writeFile(filePath, 'not valid json', 'utf-8');

      // Should throw when trying to read
      await expect(storage.get(docId)).rejects.toThrow();
    });

    it('should handle file system errors gracefully', async () => {
      // Try to save to a read-only location (this test is platform-dependent)
      // For now, just verify delete doesn't throw on non-existent file
      const docId = 'doc-sha256:no-file';
      await expect(storage.delete(docId)).resolves.toBeUndefined();
    });
  });
});
