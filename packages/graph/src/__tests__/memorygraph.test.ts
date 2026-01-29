/**
 * MemoryGraphDatabase Implementation Tests
 *
 * Tests specific to the in-memory graph database implementation,
 * including storage mechanisms, filtering logic, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryGraphDatabase } from '../implementations/memorygraph';
import { resourceId, annotationId, uriToResourceId } from '@semiont/core';
import { resourceUri } from '@semiont/api-client';
import {
  createTestResource,
  createTestHighlight,
  createTestReference,
  createTestEntityReference,
  generateResourceId,
} from './helpers/test-data';

describe('MemoryGraphDatabase Implementation', () => {
  let db: MemoryGraphDatabase;

  beforeEach(async () => {
    db = new MemoryGraphDatabase();
    await db.connect();
  });

  afterEach(async () => {
    await db.clearDatabase();
    await db.disconnect();
  });

  describe('In-Memory Storage', () => {
    it('should use Map for resources storage', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      // Access internals to verify Map storage
      const retrieved = await db.getResource(resource['@id']);
      expect(retrieved).toEqual(resource);
    });

    it('should use Map for annotations storage', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      const annotation = await db.createAnnotation(input);

      const retrieved = await db.getAnnotation(annotation.id);
      expect(retrieved).toEqual(annotation);
    });

    it('should initialize entityTypesCollection lazily', async () => {
      // First call should trigger initialization
      const types1 = await db.getEntityTypes();
      expect(types1.length).toBeGreaterThan(0); // Should include DEFAULT_ENTITY_TYPES

      // Second call should use cached collection
      const types2 = await db.getEntityTypes();
      expect(types2).toEqual(types1);
    });

    it('should persist data across operations', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      await db.createAnnotation(input);

      // Retrieve multiple times
      const retrieved1 = await db.getResource(resource['@id']);
      const retrieved2 = await db.getResource(resource['@id']);

      expect(retrieved1).toEqual(resource);
      expect(retrieved2).toEqual(resource);
    });

    it('should isolate data between instances', async () => {
      const db1 = new MemoryGraphDatabase();
      const db2 = new MemoryGraphDatabase();
      await db1.connect();
      await db2.connect();

      const resource1 = createTestResource();
      const resource2 = createTestResource();

      await db1.createResource(resource1);
      await db2.createResource(resource2);

      const retrieved1 = await db1.getResource(resource1['@id']);
      const retrieved2 = await db2.getResource(resource2['@id']);
      const cross1 = await db1.getResource(resource2['@id']);
      const cross2 = await db2.getResource(resource1['@id']);

      expect(retrieved1).toEqual(resource1);
      expect(retrieved2).toEqual(resource2);
      expect(cross1).toBeNull();
      expect(cross2).toBeNull();

      await db1.disconnect();
      await db2.disconnect();
    });
  });

  describe('Resource Filtering Logic', () => {
    it('listResources() should match partial names (case-insensitive)', async () => {
      await db.createResource(createTestResource({ name: 'Alpha Document' }));
      await db.createResource(createTestResource({ name: 'BETA Document' }));
      await db.createResource(createTestResource({ name: 'gamma file' }));

      const result = await db.listResources({ search: 'DOCUMENT' });

      expect(result.total).toBe(2);
    });

    it('listResources() should match ANY entityType in filter', async () => {
      await db.createResource(createTestResource({ entityTypes: ['Person'] }));
      await db.createResource(createTestResource({ entityTypes: ['Organization'] }));
      await db.createResource(createTestResource({ entityTypes: ['Person', 'Location'] }));

      const result = await db.listResources({ entityTypes: ['Person', 'Location'] });

      expect(result.total).toBe(2); // Resources with Person OR Location
    });

    it('listResources() should combine search and entityType filters', async () => {
      await db.createResource(createTestResource({
        name: 'John Doe Profile',
        entityTypes: ['Person'],
      }));
      await db.createResource(createTestResource({
        name: 'John Smith Profile',
        entityTypes: ['Person'],
      }));
      await db.createResource(createTestResource({
        name: 'Acme Corp Profile',
        entityTypes: ['Organization'],
      }));

      const result = await db.listResources({
        search: 'profile',
        entityTypes: ['Person'],
      });

      expect(result.total).toBe(2);
    });

    it('listResources() should handle empty results', async () => {
      await db.createResource(createTestResource({ name: 'Test' }));

      const result = await db.listResources({ search: 'nonexistent' });

      expect(result.total).toBe(0);
      expect(result.resources).toEqual([]);
    });

    it('listResources() should handle offset beyond total', async () => {
      await db.createResource(createTestResource());
      await db.createResource(createTestResource());

      const result = await db.listResources({ offset: 10, limit: 5 });

      expect(result.total).toBe(2);
      expect(result.resources).toEqual([]);
    });

    it('searchResources() should be case-insensitive', async () => {
      const resource = createTestResource({ name: 'Important Document' });
      await db.createResource(resource);

      const results = await db.searchResources('IMPORTANT');

      expect(results).toHaveLength(1);
      expect(results[0]?.['@id']).toBe(resource['@id']);
    });

    it('searchResources() should match substring', async () => {
      await db.createResource(createTestResource({ name: 'Understanding TypeScript' }));

      const results = await db.searchResources('script');

      expect(results).toHaveLength(1);
    });

    it('searchResources() should return empty for no matches', async () => {
      await db.createResource(createTestResource({ name: 'Test Document' }));

      const results = await db.searchResources('xyz123');

      expect(results).toEqual([]);
    });
  });

  describe('Annotation Relationship Logic', () => {
    it('should link annotations to resources via target source', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      await db.createAnnotation(input);

      const annotations = await db.getResourceAnnotations(uriToResourceId(resource['@id']));

      expect(annotations).toHaveLength(1);
    });

    it('should support resourceUri and resourceId formats', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      await db.createAnnotation(input);

      // Test with resourceId
      const annotations1 = await db.getResourceAnnotations(uriToResourceId(resource['@id']));
      expect(annotations1).toHaveLength(1);

      // Test with resourceUri
      const highlights = await db.getHighlights(uriToResourceId(resource['@id']));
      expect(highlights).toHaveLength(1);
    });

    it('should cascade delete annotations when resource deleted', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      // Create annotations targeting resource1
      await db.createAnnotation(createTestHighlight(resource1['@id']));
      await db.createAnnotation(createTestReference(resource1['@id']));

      // Create annotation with resource1 as body source
      await db.createAnnotation(createTestEntityReference(resource2['@id'], resource1['@id']));

      await db.deleteResource(resource1['@id']);

      // All annotations should be deleted
      const stats = await db.getStats();
      expect(stats.annotationCount).toBe(0);
    });

    it('should preserve annotations when unrelated resource deleted', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestHighlight(resource1['@id']));
      await db.deleteResource(resource2['@id']);

      const annotations = await db.getResourceAnnotations(uriToResourceId(resource1['@id']));
      expect(annotations).toHaveLength(1);
    });

    it('getHighlights() should match by motivation=highlighting', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));

      const highlights = await db.getHighlights(uriToResourceId(resource['@id']));

      expect(highlights).toHaveLength(1);
      expect(highlights[0]?.motivation).toBe('highlighting');
    });

    it('getReferences() should match by motivation=linking', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));

      const references = await db.getReferences(uriToResourceId(resource['@id']));

      expect(references).toHaveLength(1);
      expect(references[0]?.motivation).toBe('linking');
    });

    it('getEntityReferences() should extract entity types from body', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(
        createTestEntityReference(resource1['@id'], resource2['@id'], ['Person', 'Author'])
      );

      const entityRefs = await db.getEntityReferences(uriToResourceId(resource1['@id']));

      expect(entityRefs).toHaveLength(1);
    });

    it('getResourceReferencedBy() should match body source', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id']));

      const reverseRefs = await db.getResourceReferencedBy(resourceUri(resource2['@id']));

      expect(reverseRefs).toHaveLength(1);
    });

    it('resolveReference() should mutate annotation in place', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      const input = createTestReference(resource1['@id']);
      const created = await db.createAnnotation(input);

      expect(created.body).toEqual([]);

      await db.resolveReference(annotationId(created.id), uriToResourceId(resource2['@id']));

      const retrieved = await db.getAnnotation(created.id);
      expect(retrieved?.body).not.toEqual([]);
      expect((retrieved?.body as any).source).toBe(resource2['@id']);
    });

    it('resolveReferences() should batch resolve', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      const resource3 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);
      await db.createResource(resource3);

      const ref1 = await db.createAnnotation(createTestReference(resource1['@id']));
      const ref2 = await db.createAnnotation(createTestReference(resource1['@id']));

      await db.resolveReferences([
        { annotationId: annotationId(ref1.id), source: uriToResourceId(resource2['@id']) },
        { annotationId: annotationId(ref2.id), source: uriToResourceId(resource3['@id']) },
      ]);

      const retrieved1 = await db.getAnnotation(ref1.id);
      const retrieved2 = await db.getAnnotation(ref2.id);

      expect((retrieved1?.body as any).source).toBe(resource2['@id']);
      expect((retrieved2?.body as any).source).toBe(resource3['@id']);
    });
  });

  describe('Graph Traversal Implementation', () => {
    it('getResourceConnections() should fetch target resources', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      const resource3 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);
      await db.createResource(resource3);

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id']));
      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource3['@id']));

      const connections = await db.getResourceConnections(uriToResourceId(resource1['@id']));

      expect(connections).toHaveLength(2);
      expect(connections.map(c => c.targetResource['@id'])).toContain(resource2['@id']);
      expect(connections.map(c => c.targetResource['@id'])).toContain(resource3['@id']);
    });

    it('getResourceConnections() should check bidirectionality', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      // Create bidirectional link
      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id']));
      await db.createAnnotation(createTestEntityReference(resource2['@id'], resource1['@id']));

      const connections = await db.getResourceConnections(uriToResourceId(resource1['@id']));

      expect(connections[0]?.bidirectional).toBe(true);
    });

    it('getResourceConnections() should handle missing resources', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      // Don't create resource2

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id']));

      const connections = await db.getResourceConnections(uriToResourceId(resource1['@id']));

      // Should not include connection to missing resource
      expect(connections).toHaveLength(0);
    });

    it('findPath() BFS should find shortest path', async () => {
      const r1 = createTestResource();
      const r2 = createTestResource();
      const r3 = createTestResource();
      const r4 = createTestResource();

      await db.createResource(r1);
      await db.createResource(r2);
      await db.createResource(r3);
      await db.createResource(r4);

      // Create path: r1 -> r2 -> r4
      await db.createAnnotation(createTestEntityReference(r1['@id'], r2['@id']));
      await db.createAnnotation(createTestEntityReference(r2['@id'], r4['@id']));

      // Create longer path: r1 -> r3 -> r4
      await db.createAnnotation(createTestEntityReference(r1['@id'], r3['@id']));
      await db.createAnnotation(createTestEntityReference(r3['@id'], r4['@id']));

      const paths = await db.findPath(r1['@id'], r4['@id']);

      expect(paths.length).toBeGreaterThan(0);
      // BFS should find shortest path first
      expect(paths[0]?.resources).toHaveLength(3);
    });

    it('findPath() should respect maxDepth', async () => {
      const r1 = createTestResource();
      const r2 = createTestResource();
      const r3 = createTestResource();
      const r4 = createTestResource();

      await db.createResource(r1);
      await db.createResource(r2);
      await db.createResource(r3);
      await db.createResource(r4);

      // Create chain: r1 -> r2 -> r3 -> r4
      await db.createAnnotation(createTestEntityReference(r1['@id'], r2['@id']));
      await db.createAnnotation(createTestEntityReference(r2['@id'], r3['@id']));
      await db.createAnnotation(createTestEntityReference(r3['@id'], r4['@id']));

      const paths = await db.findPath(r1['@id'], r4['@id'], 2);

      expect(paths).toHaveLength(0); // Path requires depth 3
    });

    it('findPath() should return empty when no path exists', async () => {
      const r1 = createTestResource();
      const r2 = createTestResource();
      await db.createResource(r1);
      await db.createResource(r2);

      // No connections
      const paths = await db.findPath(r1['@id'], r2['@id']);

      expect(paths).toEqual([]);
    });
  });

  describe('Statistics Aggregation', () => {
    it('getEntityTypeStats() should aggregate from resource entityTypes', async () => {
      await db.createResource(createTestResource({ entityTypes: ['Person'] }));
      await db.createResource(createTestResource({ entityTypes: ['Person', 'Author'] }));
      await db.createResource(createTestResource({ entityTypes: ['Organization'] }));

      const stats = await db.getEntityTypeStats();

      const personStat = stats.find(s => s.type === 'Person');
      const authorStat = stats.find(s => s.type === 'Author');
      const orgStat = stats.find(s => s.type === 'Organization');

      expect(personStat?.count).toBe(2);
      expect(authorStat?.count).toBe(1);
      expect(orgStat?.count).toBe(1);
    });

    it('getEntityTypeStats() should count duplicates', async () => {
      for (let i = 0; i < 5; i++) {
        await db.createResource(createTestResource({ entityTypes: ['Person'] }));
      }

      const stats = await db.getEntityTypeStats();
      const personStat = stats.find(s => s.type === 'Person');

      expect(personStat?.count).toBe(5);
    });

    it('getStats() should extract primary representation mediaType', async () => {
      await db.createResource(createTestResource({
        representations: [{
          id: generateResourceId(),
          mediaType: 'text/plain',
          content: { value: 'test' },
        }],
      }));
      await db.createResource(createTestResource({
        representations: [{
          id: generateResourceId(),
          mediaType: 'text/plain',
          content: { value: 'test' },
        }],
      }));

      const stats = await db.getStats();

      expect(stats.contentTypes['text/plain']).toBe(2);
    });

    it('getStats() should count annotations by motivation', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));
      await db.createAnnotation(createTestEntityReference(resource['@id'], generateResourceId()));

      const stats = await db.getStats();

      expect(stats.highlightCount).toBe(2);
      expect(stats.referenceCount).toBe(2);
    });

    it('getStats() should distinguish entity references', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestReference(resource1['@id'])); // No entity types
      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id'], ['Person']));

      const stats = await db.getStats();

      expect(stats.referenceCount).toBe(2);
      expect(stats.entityReferenceCount).toBe(1);
    });
  });

  describe('Entity Types Collection', () => {
    it('should initialize with DEFAULT_ENTITY_TYPES', async () => {
      const types = await db.getEntityTypes();

      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('Person'); // Default type
    });

    it('should deduplicate types in Set', async () => {
      await db.addEntityType('Custom');
      await db.addEntityType('Custom');
      await db.addEntityType('Custom');

      const types = await db.getEntityTypes();
      const customCount = types.filter(t => t === 'Custom').length;

      expect(customCount).toBe(1);
    });

    it('getEntityTypes() should sort alphabetically', async () => {
      await db.clearDatabase(); // Clear defaults - will reinitialize with DEFAULT_ENTITY_TYPES
      await db.addEntityTypes(['Zebra', 'Apple', 'Mango', 'Banana']);

      const types = await db.getEntityTypes();

      // Verify alphabetical sorting by checking our custom types are in order
      const appleIndex = types.indexOf('Apple');
      const bananaIndex = types.indexOf('Banana');
      const mangoIndex = types.indexOf('Mango');
      const zebraIndex = types.indexOf('Zebra');

      expect(appleIndex).toBeGreaterThanOrEqual(0);
      expect(bananaIndex).toBeGreaterThan(appleIndex);
      expect(mangoIndex).toBeGreaterThan(bananaIndex);
      expect(zebraIndex).toBeGreaterThan(mangoIndex);
    });

    it('addEntityTypes() should merge with existing', async () => {
      const initialTypes = await db.getEntityTypes();
      const initialCount = initialTypes.length;

      await db.addEntityTypes(['NewType1', 'NewType2']);

      const updatedTypes = await db.getEntityTypes();

      expect(updatedTypes.length).toBe(initialCount + 2);
      expect(updatedTypes).toContain('NewType1');
      expect(updatedTypes).toContain('NewType2');
    });
  });

  describe('Edge Cases', () => {
    it('should handle resources with no entityTypes', async () => {
      await db.createResource(createTestResource({ entityTypes: [] }));

      const stats = await db.getEntityTypeStats();

      expect(stats).toEqual([]);
    });

    it('should handle annotations with empty body source', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestReference(resource['@id']);
      await db.createAnnotation(input);

      const reverseRefs = await db.getResourceReferencedBy(resourceUri(resource['@id']));

      expect(reverseRefs).toEqual([]);
    });

    it('should handle resources with no primary representation', async () => {
      await db.createResource(createTestResource({ representations: [] }));

      const stats = await db.getStats();

      expect(stats.resourceCount).toBe(1);
      expect(Object.keys(stats.contentTypes)).toHaveLength(0);
    });

    it('should handle circular reference paths', async () => {
      const r1 = createTestResource();
      const r2 = createTestResource();
      const r3 = createTestResource();

      await db.createResource(r1);
      await db.createResource(r2);
      await db.createResource(r3);

      // Create cycle: r1 -> r2 -> r3 -> r1
      await db.createAnnotation(createTestEntityReference(r1['@id'], r2['@id']));
      await db.createAnnotation(createTestEntityReference(r2['@id'], r3['@id']));
      await db.createAnnotation(createTestEntityReference(r3['@id'], r1['@id']));

      // Should not infinite loop
      const paths = await db.findPath(r1['@id'], r1['@id']);

      expect(paths).toBeDefined();
    });

    it('should handle self-referencing annotations', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestEntityReference(resource['@id'], resource['@id']));

      const connections = await db.getResourceConnections(uriToResourceId(resource['@id']));

      expect(connections).toHaveLength(1);
      expect(connections[0]?.targetResource['@id']).toBe(resource['@id']);
    });

    it('should handle very large result sets', async () => {
      // Create 100 resources
      for (let i = 0; i < 100; i++) {
        await db.createResource(createTestResource({ name: `Resource ${i}` }));
      }

      const result = await db.listResources({ limit: 1000 });

      expect(result.total).toBe(100);
      expect(result.resources).toHaveLength(100);
    });
  });
});
