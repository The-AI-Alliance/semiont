/**
 * ViewStorage Tests
 * Tests for FilesystemViewStorage implementation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FilesystemViewStorage } from '../../storage/view-storage';
import type { ResourceView } from '../../storage/view-storage';
import { resourceId } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import type { Motivation } from '@semiont/api-client';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Helper to create minimal ResourceDescriptor for tests
function createResourceDescriptor(id: string, name: string, overrides = {}) {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    '@id': `http://localhost:4000/resources/${id}`,
    name,
    representations: [],
    ...overrides,
  };
}

// Helper to create minimal ResourceAnnotations for tests
function createResourceAnnotations(rid: ResourceId, overrides = {}) {
  return {
    resourceId: rid,
    version: 0,
    updatedAt: new Date().toISOString(),
    annotations: [],
    ...overrides,
  };
}

describe('FilesystemViewStorage', () => {
  let testDir: string;
  let storage: FilesystemViewStorage;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-viewstorage-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    storage = new FilesystemViewStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Constructor', () => {
    it('should create FilesystemViewStorage with basePath', () => {
      expect(storage).toBeDefined();
    });

    it('should handle relative basePath', () => {
      const relativeStorage = new FilesystemViewStorage('data');
      expect(relativeStorage).toBeDefined();
    });

    it('should handle absolute basePath', () => {
      const absoluteStorage = new FilesystemViewStorage(testDir);
      expect(absoluteStorage).toBeDefined();
    });
  });

  describe('save()', () => {
    it('should save a resource view', async () => {
      const rid = resourceId('doc1');
      const view: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Test Document', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid),
      };

      await storage.save(rid, view);

      const retrieved = await storage.get(rid);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.resource.name).toBe('Test Document');
    });

    it('should overwrite existing view', async () => {
      const rid = resourceId('doc1');
      const view1: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Version 1', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid),
      };

      const view2: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Version 2', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid),
      };

      await storage.save(rid, view1);
      await storage.save(rid, view2);

      const retrieved = await storage.get(rid);
      expect(retrieved?.resource.name).toBe('Version 2');
    });
  });

  describe('get()', () => {
    it('should retrieve saved view', async () => {
      const rid = resourceId('doc1');
      const view: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Test Document', {
          format: 'text/plain',
          representations: [{
            '@id': 'checksum1',
            mediaType: 'text/plain',
            byteSize: 100,
            checksum: 'checksum1',
            created: new Date().toISOString(),
          }],
        }),
        annotations: createResourceAnnotations(rid),
      };

      await storage.save(rid, view);
      const retrieved = await storage.get(rid);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.resource['@id']).toBe('http://localhost:4000/resources/doc1');
      expect(retrieved?.resource.name).toBe('Test Document');
      expect(retrieved?.resource.representations).toHaveLength(1);
    });

    it('should return null for non-existent view', async () => {
      const rid = resourceId('nonexistent');
      const view = await storage.get(rid);
      expect(view).toBeNull();
    });
  });

  describe('delete()', () => {
    it('should delete a view', async () => {
      const rid = resourceId('doc1');
      const view: ResourceView = {
        resource: createResourceDescriptor('doc1', 'To Delete', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid),
      };

      await storage.save(rid, view);
      expect(await storage.get(rid)).not.toBeNull();

      await storage.delete(rid);
      expect(await storage.get(rid)).toBeNull();
    });

    it('should not throw when deleting non-existent view', async () => {
      const rid = resourceId('nonexistent');
      await expect(storage.delete(rid)).resolves.not.toThrow();
    });
  });

  describe('exists()', () => {
    it('should return true for existing view', async () => {
      const rid = resourceId('doc1');
      const view: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Test', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid),
      };

      await storage.save(rid, view);
      const exists = await storage.exists(rid);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent view', async () => {
      const rid = resourceId('nonexistent');
      const exists = await storage.exists(rid);
      expect(exists).toBe(false);
    });
  });

  describe('getAll()', () => {
    it('should return all views', async () => {
      const rid1 = resourceId('doc1');
      const rid2 = resourceId('doc2');

      const view1: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Doc 1', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid1),
      };

      const view2: ResourceView = {
        resource: createResourceDescriptor('doc2', 'Doc 2', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid2),
      };

      await storage.save(rid1, view1);
      await storage.save(rid2, view2);

      const views = await storage.getAll();

      expect(views.length).toBeGreaterThanOrEqual(2);
      const names = views.map(v => v.resource.name);
      expect(names).toContain('Doc 1');
      expect(names).toContain('Doc 2');
    });

    it('should return empty array when no views exist', async () => {
      const views = await storage.getAll();
      expect(views).toEqual([]);
    });
  });

  describe('Complex views', () => {
    it('should handle view with multiple representations', async () => {
      const rid = resourceId('doc1');
      const view: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Multi-Rep Document', {
          format: 'text/plain',
          representations: [
            {
              '@id': 'checksum1',
              mediaType: 'text/plain',
              byteSize: 100,
              checksum: 'checksum1',
              created: new Date().toISOString(),
            },
            {
              '@id': 'checksum2',
              mediaType: 'text/html',
              byteSize: 200,
              checksum: 'checksum2',
              created: new Date().toISOString(),
            },
          ],
        }),
        annotations: createResourceAnnotations(rid),
      };

      await storage.save(rid, view);
      const retrieved = await storage.get(rid);

      expect(retrieved?.resource.representations).toHaveLength(2);
      expect(retrieved?.resource.representations[0].mediaType).toBe('text/plain');
      expect(retrieved?.resource.representations[1].mediaType).toBe('text/html');
    });

    it('should handle view with multiple annotations', async () => {
      const rid = resourceId('doc1');
      const view: ResourceView = {
        resource: createResourceDescriptor('doc1', 'Annotated Document', {
          format: 'text/plain',
        }),
        annotations: createResourceAnnotations(rid, {
          annotations: [
            {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              id: 'http://localhost:4000/annotations/anno1',
              type: 'Annotation' as const,
              motivation: 'commenting' satisfies Motivation,
              body: [],
              target: 'http://localhost:4000/resources/doc1',
              created: new Date().toISOString(),
              creator: { id: 'http://localhost:4000/users/user1', type: 'Person' },
            },
            {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              id: 'http://localhost:4000/annotations/anno2',
              type: 'Annotation' as const,
              motivation: 'commenting' satisfies Motivation,
              body: [],
              target: 'http://localhost:4000/resources/doc1',
              created: new Date().toISOString(),
              creator: { id: 'http://localhost:4000/users/user1', type: 'Person' },
            },
          ],
        }),
      };

      await storage.save(rid, view);
      const retrieved = await storage.get(rid);

      expect(retrieved?.annotations.annotations).toHaveLength(2);
    });
  });
});
