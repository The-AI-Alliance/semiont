/**
 * ProjectionQuery Tests
 * Tests for Layer 3 projection query operations
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProjectionStorage, type ResourceState } from '../../storage/projection/projection-storage-v2';
import { ProjectionQuery } from '../../storage/projection/projection-query';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { components } from '@semiont/api-client';
import type { ResourceAnnotations } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
import { createTestResource } from '../fixtures/resource-fixtures';
import { getResourceId } from '../../utils/resource-helpers';

describe('ProjectionQuery', () => {
  let testDir: string;
  let storage: ProjectionStorage;
  let query: ProjectionQuery;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-projection-query-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    storage = new ProjectionStorage({
      basePath: testDir,
      subNamespace: 'query-test',
    });

    query = new ProjectionQuery(storage);

    // Seed test data
    await seedTestData();
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create test resource state
  const createDocState = (
    id: string,
    name: string,
    creator: string,
    entityTypes: string[],
    archived: boolean,
    annotationCount: number
  ): ResourceState => {
    const resource: ResourceDescriptor = createTestResource({
      id,
      name,
      primaryMediaType: 'text/plain',
      creator: {
        '@id': creator,
        '@type': 'Person',
        name: `User ${creator}`,
      },
      archived,
      entityTypes,
      checksum: 'test',
    });

    const annotations: ResourceAnnotations = {
      resourceId: id,
      version: 1,
      updatedAt: '2025-01-01T00:00:00.000Z',
      annotations: Array.from({ length: annotationCount }, (_, i) => ({
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation' as const,
        id: `ann-${id}-${i}`,
        motivation: 'highlighting' as const,
        target: { source: id },
        body: [],
        creator: {
          id: creator,
          type: 'Person',
          name: `User ${creator}`,
        },
        created: '2025-01-01T00:00:00.000Z',
        modified: '2025-01-01T00:00:00.000Z',
      })),
    };

    return { resource, annotations };
  };

  async function seedTestData() {
    // Create diverse test resources
    await storage.save('doc-1', createDocState('doc-1', 'Alice Resource', 'user-alice', ['Person'], false, 3));
    await storage.save('doc-2', createDocState('doc-2', 'Bob Resource', 'user-bob', ['Organization'], false, 5));
    await storage.save('doc-3', createDocState('doc-3', 'Alice Report', 'user-alice', ['Person', 'Resource'], false, 0));
    await storage.save('doc-4', createDocState('doc-4', 'Archived Doc', 'user-charlie', ['Resource'], true, 2));
    await storage.save('doc-5', createDocState('doc-5', 'Charlie Resource', 'user-charlie', ['Person'], false, 10));
    await storage.save('doc-6', createDocState('doc-6', 'Empty Annotations', 'user-alice', ['Organization'], false, 0));
    await storage.save('doc-7', createDocState('doc-7', 'Another Archived', 'user-bob', ['Person'], true, 1));
  }

  describe('Entity Type Queries', () => {
    it('should find resources by entity type', async () => {
      const results = await query.findByEntityType('Person');

      expect(results.length).toBe(4); // doc-1, doc-3, doc-5, doc-7
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-1');
      expect(ids).toContain('doc-3');
      expect(ids).toContain('doc-5');
      expect(ids).toContain('doc-7');
    });

    it('should find resources with Organization entity type', async () => {
      const results = await query.findByEntityType('Organization');

      expect(results.length).toBe(2); // doc-2, doc-6
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-2');
      expect(ids).toContain('doc-6');
    });

    it('should return empty array for non-existent entity type', async () => {
      const results = await query.findByEntityType('NonExistentType');
      expect(results).toEqual([]);
    });

    it('should handle resources with multiple entity types', async () => {
      const personResults = await query.findByEntityType('Person');
      const resourceResults = await query.findByEntityType('Resource');

      // doc-3 has both Person and Resource
      const personIds = personResults.map(r => getResourceId(r.resource));
      const resourceIds = resourceResults.map(r => getResourceId(r.resource));

      expect(personIds).toContain('doc-3');
      expect(resourceIds).toContain('doc-3');
    });

    it('should count resources by entity type', async () => {
      const personCount = await query.countByEntityType('Person');
      const orgCount = await query.countByEntityType('Organization');
      const docCount = await query.countByEntityType('Resource');

      expect(personCount).toBe(4);
      expect(orgCount).toBe(2);
      expect(docCount).toBe(2);
    });
  });

  describe('Creator Queries', () => {
    it('should find resources by creator', async () => {
      const aliceResults = await query.findByCreator('user-alice');

      expect(aliceResults.length).toBe(3); // doc-1, doc-3, doc-6
      const ids = aliceResults.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-1');
      expect(ids).toContain('doc-3');
      expect(ids).toContain('doc-6');
    });

    it('should find resources for different creators', async () => {
      const bobResults = await query.findByCreator('user-bob');
      const charlieResults = await query.findByCreator('user-charlie');

      expect(bobResults.length).toBe(2); // doc-2, doc-7
      expect(charlieResults.length).toBe(2); // doc-4, doc-5
    });

    it('should return empty array for non-existent creator', async () => {
      const results = await query.findByCreator('user-nonexistent');
      expect(results).toEqual([]);
    });
  });

  describe('Archive Status Queries', () => {
    it('should find all archived resources', async () => {
      const results = await query.findArchived();

      expect(results.length).toBe(2); // doc-4, doc-7
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-4');
      expect(ids).toContain('doc-7');
    });

    it('should find all active resources', async () => {
      const results = await query.findActive();

      expect(results.length).toBe(5); // doc-1, doc-2, doc-3, doc-5, doc-6
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-1');
      expect(ids).toContain('doc-2');
      expect(ids).toContain('doc-3');
      expect(ids).toContain('doc-5');
      expect(ids).toContain('doc-6');
    });

    it('should correctly identify archived status', async () => {
      const archived = await query.findArchived();
      const active = await query.findActive();

      // Verify no overlap
      const archivedIds = new Set(archived.map(r => getResourceId(r.resource)));
      const activeIds = new Set(active.map(r => getResourceId(r.resource)));

      for (const id of archivedIds) {
        expect(activeIds.has(id)).toBe(false);
      }
    });
  });

  describe('Annotation Count Queries', () => {
    it('should get annotation count for resource', async () => {
      const count1 = await query.getAnnotationCount('doc-1');
      const count2 = await query.getAnnotationCount('doc-2');
      const count5 = await query.getAnnotationCount('doc-5');

      expect(count1).toBe(3);
      expect(count2).toBe(5);
      expect(count5).toBe(10);
    });

    it('should return 0 for resources with no annotations', async () => {
      const count3 = await query.getAnnotationCount('doc-3');
      const count6 = await query.getAnnotationCount('doc-6');

      expect(count3).toBe(0);
      expect(count6).toBe(0);
    });

    it('should return 0 for non-existent resource', async () => {
      const count = await query.getAnnotationCount('doc-nonexistent');
      expect(count).toBe(0);
    });

    it('should find resources by minimum annotation count', async () => {
      const results = await query.findByAnnotationCount(5);

      expect(results.length).toBe(2); // doc-2 (5), doc-5 (10)
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-2');
      expect(ids).toContain('doc-5');
    });

    it('should find all resources with at least 1 annotation', async () => {
      const results = await query.findByAnnotationCount(1);

      expect(results.length).toBe(5); // All except doc-3 and doc-6
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).not.toContain('doc-3');
      expect(ids).not.toContain('doc-6');
    });

    it('should return empty for very high annotation count', async () => {
      const results = await query.findByAnnotationCount(100);
      expect(results).toEqual([]);
    });
  });

  describe('Name Search Queries', () => {
    it('should search resources by name (case-insensitive)', async () => {
      const results = await query.searchByName('alice');

      expect(results.length).toBe(2); // 'Alice Resource', 'Alice Report'
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-1');
      expect(ids).toContain('doc-3');
    });

    it('should find resources with partial name match', async () => {
      const results = await query.searchByName('doc');

      // All resources have 'doc' in lowercase name
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle case-insensitive search', async () => {
      const lowerResults = await query.searchByName('resource');
      const upperResults = await query.searchByName('DOCUMENT');
      const mixedResults = await query.searchByName('DoCuMeNt');

      expect(lowerResults.length).toBe(upperResults.length);
      expect(lowerResults.length).toBe(mixedResults.length);
    });

    it('should return empty for non-matching search', async () => {
      const results = await query.searchByName('xyz-nonexistent-name');
      expect(results).toEqual([]);
    });

    it('should search by specific words', async () => {
      const archivedResults = await query.searchByName('archived');
      expect(archivedResults.length).toBe(2); // 'Archived Doc', 'Another Archived'
    });
  });

  describe('Count Operations', () => {
    it('should count all projections', async () => {
      const total = await query.count();
      expect(total).toBe(7); // All seeded resources
    });

    it('should check if any projections exist', async () => {
      const hasAny = await query.hasAny();
      expect(hasAny).toBe(true);
    });

    it('should return false when no projections exist', async () => {
      const emptyStorage = new ProjectionStorage({
        basePath: testDir,
        subNamespace: 'empty-test',
      });
      const emptyQuery = new ProjectionQuery(emptyStorage);

      const hasAny = await emptyQuery.hasAny();
      expect(hasAny).toBe(false);

      const count = await emptyQuery.count();
      expect(count).toBe(0);
    });
  });

  describe('Complex Queries', () => {
    it('should combine filters programmatically', async () => {
      // Find active resources by Alice
      const aliceDocs = await query.findByCreator('user-alice');
      const activeDocs = aliceDocs.filter(d => !d.resource.archived);

      expect(activeDocs.length).toBe(3); // All Alice's docs are active
    });

    it('should filter by entity type and annotation count', async () => {
      const personDocs = await query.findByEntityType('Person');
      const withAnnotations = personDocs.filter(d => d.annotations.annotations.length > 0);

      expect(withAnnotations.length).toBe(3); // doc-1 (3), doc-5 (10), doc-7 (1)
    });

    it('should search and filter by creator', async () => {
      const searchResults = await query.searchByName('Resource');
      const aliceResults = searchResults.filter(d => {
        const creator = d.resource.wasAttributedTo;
        if (!creator) return false;
        const creatorId = Array.isArray(creator) ? creator[0]?.['@id'] : creator['@id'];
        return creatorId === 'user-alice';
      });

      expect(aliceResults.length).toBe(1); // Only 'Alice Resource'
      if (aliceResults[0]) {
        expect(getResourceId(aliceResults[0].resource)).toBe('doc-1');
      }
    });
  });

  describe('Performance and Edge Cases', () => {
    it('should handle querying empty result sets efficiently', async () => {
      const results = await query.findByEntityType('NonExistent');
      expect(results).toEqual([]);
    });

    it('should handle resources with empty entity types array', async () => {
      const emptyEntityDoc = createDocState('doc-empty', 'No Entities', 'user-test', [], false, 0);
      await storage.save('doc-empty', emptyEntityDoc);

      const results = await query.findByEntityType('AnyType');
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).not.toContain('doc-empty');
    });

    it('should handle special characters in search', async () => {
      const specialDoc = createDocState('doc-special', 'Test-Resource_123', 'user-test', [], false, 0);
      await storage.save('doc-special', specialDoc);

      const results = await query.searchByName('Test-Resource');
      const ids = results.map(r => getResourceId(r.resource));
      expect(ids).toContain('doc-special');
    });

    it('should return consistent results on repeated queries', async () => {
      const results1 = await query.findByEntityType('Person');
      const results2 = await query.findByEntityType('Person');

      expect(results1.length).toBe(results2.length);
      expect(results1.map(r => getResourceId(r.resource)).sort()).toEqual(
        results2.map(r => getResourceId(r.resource)).sort()
      );
    });
  });
});
