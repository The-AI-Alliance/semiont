/**
 * ProjectionManager Tests
 * Tests for Layer 3 projection manager orchestration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectionManager, type DocumentState } from '../../storage/projection/projection-manager';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { components } from '@semiont/api-client';
import type { DocumentAnnotations } from '@semiont/core';

import { createTestResource } from '../fixtures/resource-fixtures';
import { getResourceId } from '../../utils/resource-helpers';
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

describe('ProjectionManager', () => {
  let testDir: string;
  let manager: ProjectionManager;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-projection-manager-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    manager = new ProjectionManager({
      basePath: testDir,
      subNamespace: 'manager-test',
    });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create test document state
  const createTestState = (docId: string): DocumentState => {
    const document: ResourceDescriptor = createTestResource({
      id: docId,
      name: `Test Document ${docId}`,
      primaryMediaType: 'text/plain',
      creator: {
        '@id': 'user-test',
        '@type': 'Person',
        name: 'Test User',
      },
      archived: false,
      entityTypes: [],
      checksum: 'sha256:test',
    });

    const annotations: DocumentAnnotations = {
      documentId: docId,
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      annotations: [],
    };

    return { document, annotations };
  };

  describe('Module Initialization', () => {
    it('should initialize with storage and query modules', () => {
      expect(manager.storage).toBeDefined();
      expect(manager.query).toBeDefined();
    });

    it('should allow multiple instances with different configs', () => {
      const manager2 = new ProjectionManager({
        basePath: testDir,
        subNamespace: 'other-namespace',
      });

      expect(manager2.storage).toBeDefined();
      expect(manager2.query).toBeDefined();
      expect(manager2).not.toBe(manager);
    });
  });

  describe('Save Operations', () => {
    it('should save projection via manager', async () => {
      const docId = 'doc-save-1';
      const state = createTestState(docId);

      await manager.save(docId, state);

      const exists = await manager.exists(docId);
      expect(exists).toBe(true);
    });

    it('should delegate save to storage module', async () => {
      const docId = 'doc-save-2';
      const state = createTestState(docId);

      await manager.save(docId, state);

      // Verify via direct storage access
      const loaded = await manager.storage.get(docId);
      expect(loaded ? getResourceId(loaded.document) : null).toBe(docId);
    });

    it('should handle multiple saves', async () => {
      const docIds = ['doc-multi-1', 'doc-multi-2', 'doc-multi-3'];

      for (const docId of docIds) {
        await manager.save(docId, createTestState(docId));
      }

      for (const docId of docIds) {
        expect(await manager.exists(docId)).toBe(true);
      }
    });
  });

  describe('Get Operations', () => {
    it('should retrieve projection via manager', async () => {
      const docId = 'doc-get-1';
      const state = createTestState(docId);

      await manager.save(docId, state);

      const loaded = await manager.get(docId);
      expect(loaded).not.toBeNull();
      expect(loaded ? getResourceId(loaded.document) : null).toBe(docId);
    });

    it('should return null for non-existent projection', async () => {
      const loaded = await manager.get('doc-nonexistent');
      expect(loaded).toBeNull();
    });

    it('should delegate get to storage module', async () => {
      const docId = 'doc-get-2';
      const state = createTestState(docId);

      await manager.save(docId, state);

      const viaManager = await manager.get(docId);
      const viaStorage = await manager.storage.get(docId);

      expect(viaManager ? getResourceId(viaManager.document) : null).toBe(viaStorage ? getResourceId(viaStorage.document) : null);
    });
  });

  describe('Delete Operations', () => {
    it('should delete projection via manager', async () => {
      const docId = 'doc-delete-1';
      const state = createTestState(docId);

      await manager.save(docId, state);
      expect(await manager.exists(docId)).toBe(true);

      await manager.delete(docId);
      expect(await manager.exists(docId)).toBe(false);
    });

    it('should delegate delete to storage module', async () => {
      const docId = 'doc-delete-2';
      const state = createTestState(docId);

      await manager.save(docId, state);
      await manager.delete(docId);

      const loaded = await manager.storage.get(docId);
      expect(loaded).toBeNull();
    });

    it('should not throw when deleting non-existent projection', async () => {
      await expect(manager.delete('doc-never-existed')).resolves.toBeUndefined();
    });
  });

  describe('Exists Operations', () => {
    it('should check existence via manager', async () => {
      const docId = 'doc-exists-1';
      const state = createTestState(docId);

      expect(await manager.exists(docId)).toBe(false);

      await manager.save(docId, state);
      expect(await manager.exists(docId)).toBe(true);

      await manager.delete(docId);
      expect(await manager.exists(docId)).toBe(false);
    });
  });

  describe('Bulk Operations', () => {
    it('should get all projections', async () => {
      const manager2 = new ProjectionManager({
        basePath: testDir,
        subNamespace: 'bulk-test',
      });

      const docIds = ['doc-bulk-1', 'doc-bulk-2', 'doc-bulk-3'];
      for (const docId of docIds) {
        await manager2.save(docId, createTestState(docId));
      }

      const all = await manager2.getAll();
      expect(all.length).toBe(3);

      const ids = all.map(s => getResourceId(s.document));
      expect(ids).toContain('doc-bulk-1');
      expect(ids).toContain('doc-bulk-2');
      expect(ids).toContain('doc-bulk-3');
    });

    it('should get all document IDs', async () => {
      const manager3 = new ProjectionManager({
        basePath: testDir,
        subNamespace: 'ids-test',
      });

      const docIds = ['doc-id-1', 'doc-id-2'];
      for (const docId of docIds) {
        await manager3.save(docId, createTestState(docId));
      }

      const allIds = await manager3.getAllDocumentIds();
      expect(allIds.length).toBe(2);
      expect(allIds).toContain('doc-id-1');
      expect(allIds).toContain('doc-id-2');
    });
  });

  describe('System Projections', () => {
    it('should save and get system projection', async () => {
      const data = { setting: 'value', count: 42 };

      await manager.saveSystem('config.json', data);

      const loaded = await manager.getSystem('config.json');
      expect(loaded).toEqual(data);
    });

    it('should return null for non-existent system projection', async () => {
      const loaded = await manager.getSystem('nonexistent.json');
      expect(loaded).toBeNull();
    });

    it('should handle typed system projections', async () => {
      interface Config {
        enabled: boolean;
        maxCount: number;
      }

      const config: Config = {
        enabled: true,
        maxCount: 100,
      };

      await manager.saveSystem('typed-config.json', config);

      const loaded = await manager.getSystem<Config>('typed-config.json');
      expect(loaded?.enabled).toBe(true);
      expect(loaded?.maxCount).toBe(100);
    });
  });

  describe('Query Integration', () => {
    it('should provide access to query module', () => {
      expect(manager.query).toBeDefined();
      expect(typeof manager.query.findByEntityType).toBe('function');
    });

    it('should allow querying through manager', async () => {
      const manager4 = new ProjectionManager({
        basePath: testDir,
        subNamespace: 'query-integration',
      });

      const state = createTestState('doc-query-1');
      state.document.entityTypes = ['Person'];
      await manager4.save('doc-query-1', state);

      const results = await manager4.query.findByEntityType('Person');
      expect(results.length).toBe(1);
      expect(results[0] ? getResourceId(results[0].document) : null).toBe('doc-query-1');
    });
  });

  describe('Backward Compatibility', () => {
    it('should support deprecated saveProjection method', async () => {
      const docId = 'doc-compat-save';
      const state = createTestState(docId);

      await manager.saveProjection(docId, state);

      const exists = await manager.exists(docId);
      expect(exists).toBe(true);
    });

    it('should support deprecated getProjection method', async () => {
      const docId = 'doc-compat-get';
      const state = createTestState(docId);

      await manager.save(docId, state);

      const loaded = await manager.getProjection(docId);
      expect(loaded ? getResourceId(loaded.document) : null).toBe(docId);
    });

    it('should support deprecated deleteProjection method', async () => {
      const docId = 'doc-compat-delete';
      const state = createTestState(docId);

      await manager.save(docId, state);
      await manager.deleteProjection(docId);

      expect(await manager.exists(docId)).toBe(false);
    });

    it('should support deprecated projectionExists method', async () => {
      const docId = 'doc-compat-exists';
      const state = createTestState(docId);

      await manager.save(docId, state);

      const exists = await manager.projectionExists(docId);
      expect(exists).toBe(true);
    });

    it('should support deprecated getAllProjections method', async () => {
      const manager5 = new ProjectionManager({
        basePath: testDir,
        subNamespace: 'compat-getall',
      });

      await manager5.save('doc-compat-1', createTestState('doc-compat-1'));

      const all = await manager5.getAllProjections();
      expect(all.length).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle errors from storage layer', async () => {
      // Try to get with invalid ID that causes issues
      const loaded = await manager.get('doc-invalid-<>?');
      // Should gracefully handle (return null or throw appropriately)
      expect(loaded).toBeNull();
    });

    it('should handle concurrent operations', async () => {
      const docId = 'doc-concurrent';
      const state = createTestState(docId);

      // Save concurrently (should not corrupt data)
      await Promise.all([
        manager.save(docId, state),
        manager.save(docId, state),
        manager.save(docId, state),
      ]);

      const loaded = await manager.get(docId);
      expect(loaded ? getResourceId(loaded.document) : null).toBe(docId);
    });
  });

  describe('Orchestration Behavior', () => {
    it('should properly delegate to storage for CRUD', async () => {
      const docId = 'doc-orchestration';
      const state = createTestState(docId);

      // Save via manager
      await manager.save(docId, state);

      // Verify via direct storage access
      const fromStorage = await manager.storage.get(docId);
      expect(fromStorage ? getResourceId(fromStorage.document) : null).toBe(docId);

      // Delete via manager
      await manager.delete(docId);

      // Verify via direct storage access
      const afterDelete = await manager.storage.get(docId);
      expect(afterDelete).toBeNull();
    });

    it('should maintain separation between modules', () => {
      // Storage and query should be separate instances
      expect(manager.storage).not.toBe(manager.query);

      // But query should use the same storage
      expect((manager.query as any).storage).toBe(manager.storage);
    });
  });
});
