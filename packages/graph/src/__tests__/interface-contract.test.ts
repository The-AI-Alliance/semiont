/**
 * Interface Contract Tests for GraphDatabase
 *
 * These tests validate that ANY GraphDatabase implementation follows the interface contract.
 * Run against MemoryGraphDatabase as the reference implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryGraphDatabase } from '../implementations/memorygraph';
import type { GraphDatabase } from '../interface';
import { resourceId, annotationId, uriToResourceId } from '@semiont/core';
import { resourceUri, type ResourceUri, type AnnotationUri } from '@semiont/api-client';
import {
  createTestResource,
  createTestHighlight,
  createTestReference,
  createTestEntityReference,
  generateResourceId,
} from './helpers/test-data';

describe('GraphDatabase Interface Contract', () => {
  let db: GraphDatabase;

  beforeEach(async () => {
    db = new MemoryGraphDatabase();
    await db.connect();
  });

  afterEach(async () => {
    await db.clearDatabase();
    await db.disconnect();
  });

  describe('Connection Management', () => {
    it('connect() should establish connection', async () => {
      const newDb = new MemoryGraphDatabase();
      expect(newDb.isConnected()).toBe(false);

      await newDb.connect();

      expect(newDb.isConnected()).toBe(true);
      await newDb.disconnect();
    });

    it('disconnect() should close connection', async () => {
      expect(db.isConnected()).toBe(true);

      await db.disconnect();

      expect(db.isConnected()).toBe(false);
      await db.connect(); // Restore for afterEach
    });

    it('isConnected() should reflect connection state', async () => {
      const newDb = new MemoryGraphDatabase();

      expect(newDb.isConnected()).toBe(false);
      await newDb.connect();
      expect(newDb.isConnected()).toBe(true);
      await newDb.disconnect();
      expect(newDb.isConnected()).toBe(false);
    });
  });

  describe('Resource Operations', () => {
    it('createResource() should create and return resource', async () => {
      const resource = createTestResource();

      const created = await db.createResource(resource);

      expect(created).toEqual(resource);
      expect(created['@id']).toBe(resource['@id']);
    });

    it('createResource() should require resource id', async () => {
      const resource = createTestResource({ '@id': undefined } as any);

      await expect(db.createResource(resource)).rejects.toThrow();
    });

    it('getResource() should retrieve existing resource', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const retrieved = await db.getResource(resource['@id'] as ResourceUri);

      expect(retrieved).toEqual(resource);
    });

    it('getResource() should return null for non-existent resource', async () => {
      const retrieved = await db.getResource(resourceUri('http://example.com/nonexistent'));

      expect(retrieved).toBeNull();
    });

    it('updateResource() should only allow archiving', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const updated = await db.updateResource(resource['@id'] as ResourceUri, { archived: true });

      expect(updated.archived).toBe(true);
      expect(updated['@id']).toBe(resource['@id']);
    });

    it('updateResource() should reject other mutations', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await expect(
        db.updateResource(resource['@id'] as ResourceUri, { name: 'New Name' } as any)
      ).rejects.toThrow(/immutable/i);
    });

    it('updateResource() should throw for non-existent resource', async () => {
      await expect(
        db.updateResource(resourceUri('http://example.com/nonexistent'), { archived: true })
      ).rejects.toThrow();
    });

    it('deleteResource() should remove resource', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.deleteResource(resource['@id'] as ResourceUri);

      const retrieved = await db.getResource(resource['@id'] as ResourceUri);
      expect(retrieved).toBeNull();
    });

    it('deleteResource() should cascade delete annotations', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const highlight = createTestHighlight(resource['@id']);
      const annotation = await db.createAnnotation(highlight);

      await db.deleteResource(resource['@id'] as ResourceUri);

      const retrievedAnnotation = await db.getAnnotation(annotation.id as AnnotationUri);
      expect(retrievedAnnotation).toBeNull();
    });

    it('listResources() should filter by entityTypes', async () => {
      const resource1 = createTestResource({ entityTypes: ['Person'] });
      const resource2 = createTestResource({ entityTypes: ['Organization'] });
      const resource3 = createTestResource({ entityTypes: ['Person', 'Organization'] });

      await db.createResource(resource1);
      await db.createResource(resource2);
      await db.createResource(resource3);

      const result = await db.listResources({ entityTypes: ['Person'] });

      expect(result.total).toBe(2);
      expect(result.resources).toHaveLength(2);
      expect(result.resources.some(r => r['@id'] === resource1['@id'])).toBe(true);
      expect(result.resources.some(r => r['@id'] === resource3['@id'])).toBe(true);
    });

    it('listResources() should filter by search query', async () => {
      const resource1 = createTestResource({ name: 'Alpha Document' });
      const resource2 = createTestResource({ name: 'Beta Document' });
      const resource3 = createTestResource({ name: 'Gamma File' });

      await db.createResource(resource1);
      await db.createResource(resource2);
      await db.createResource(resource3);

      const result = await db.listResources({ search: 'document' });

      expect(result.total).toBe(2);
      expect(result.resources).toHaveLength(2);
    });

    it('listResources() should paginate results', async () => {
      for (let i = 0; i < 5; i++) {
        await db.createResource(createTestResource({ name: `Resource ${i}` }));
      }

      const page1 = await db.listResources({ limit: 2, offset: 0 });
      const page2 = await db.listResources({ limit: 2, offset: 2 });

      expect(page1.resources).toHaveLength(2);
      expect(page2.resources).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page2.total).toBe(5);
    });

    it('listResources() should return total count', async () => {
      await db.createResource(createTestResource());
      await db.createResource(createTestResource());
      await db.createResource(createTestResource());

      const result = await db.listResources({});

      expect(result.total).toBe(3);
    });

    it('searchResources() should find by text query', async () => {
      const resource = createTestResource({ name: 'Unique Searchable Name' });
      await db.createResource(resource);
      await db.createResource(createTestResource({ name: 'Other Document' }));

      const results = await db.searchResources('Searchable');

      expect(results).toHaveLength(1);
      expect(results[0]?.['@id']).toBe(resource['@id']);
    });

    it('searchResources() should respect limit', async () => {
      for (let i = 0; i < 5; i++) {
        await db.createResource(createTestResource({ name: 'Test Document' }));
      }

      const results = await db.searchResources('Test', 2);

      expect(results).toHaveLength(2);
    });
  });

  describe('Annotation Operations', () => {
    it('createAnnotation() should create with highlighting motivation', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      const annotation = await db.createAnnotation(input);

      expect(annotation.id).toBeDefined();
      expect(annotation.motivation).toBe('highlighting');
      expect(annotation.creator).toBe(input.creator);
    });

    it('createAnnotation() should create with linking motivation', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestReference(resource['@id']);
      const annotation = await db.createAnnotation(input);

      expect(annotation.id).toBeDefined();
      expect(annotation.motivation).toBe('linking');
    });

    it('createAnnotation() should generate unique id', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      const ann1 = await db.createAnnotation(input);
      const ann2 = await db.createAnnotation(input);

      expect(ann1.id).not.toBe(ann2.id);
    });

    it('getAnnotation() should retrieve existing annotation', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      const created = await db.createAnnotation(input);

      const retrieved = await db.getAnnotation(created.id as AnnotationUri);

      expect(retrieved).toEqual(created);
    });

    it('getAnnotation() should return null for non-existent', async () => {
      const retrieved = await db.getAnnotation('nonexistent-id' as AnnotationUri);

      expect(retrieved).toBeNull();
    });

    it('updateAnnotation() should update fields', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      const created = await db.createAnnotation(input);

      const newBody = {
        type: 'TextualBody' as const,
        value: 'Updated highlight',
        format: 'text/plain' as const,
        purpose: 'commenting' as const,
      };

      const updated = await db.updateAnnotation(created.id as AnnotationUri, { body: newBody });

      expect(updated.body).toEqual(newBody);
      expect(updated.id).toBe(created.id);
    });

    it('updateAnnotation() should preserve unchanged fields', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      const created = await db.createAnnotation(input);

      const updated = await db.updateAnnotation(created.id as AnnotationUri, {});

      expect(updated.creator).toBe(created.creator);
      expect(updated.motivation).toBe(created.motivation);
    });

    it('deleteAnnotation() should remove annotation', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const input = createTestHighlight(resource['@id']);
      const created = await db.createAnnotation(input);

      await db.deleteAnnotation(created.id as AnnotationUri);

      const retrieved = await db.getAnnotation(created.id as AnnotationUri);
      expect(retrieved).toBeNull();
    });

    it('listAnnotations() should filter by resourceId', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestHighlight(resource1['@id']));
      await db.createAnnotation(createTestHighlight(resource1['@id']));
      await db.createAnnotation(createTestHighlight(resource2['@id']));

      const result = await db.listAnnotations({ resourceId: uriToResourceId(resource1['@id']) });

      expect(result.total).toBe(2);
      expect(result.annotations).toHaveLength(2);
    });

    it('listAnnotations() should filter by type (highlight vs reference)', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));

      const highlights = await db.listAnnotations({ type: 'highlight' });
      const references = await db.listAnnotations({ type: 'reference' });

      expect(highlights.total).toBe(2);
      expect(references.total).toBe(1);
    });

    it('listAnnotations() should return total count', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestHighlight(resource['@id']));

      const result = await db.listAnnotations({});

      expect(result.total).toBe(2);
      expect(result.annotations).toHaveLength(2);
    });

    it('createAnnotations() should batch create', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const inputs = [
        createTestHighlight(resource['@id']),
        createTestHighlight(resource['@id']),
        createTestReference(resource['@id']),
      ];

      const annotations = await db.createAnnotations(inputs);

      expect(annotations).toHaveLength(3);
      expect(annotations[0]?.id).toBeDefined();
      expect(annotations[1]?.id).toBeDefined();
      expect(annotations[2]?.id).toBeDefined();
    });
  });

  describe('Highlight Operations', () => {
    it('getHighlights() should return only highlighting annotations', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));

      const highlights = await db.getHighlights(uriToResourceId(resource['@id']));

      expect(highlights).toHaveLength(2);
      expect(highlights.every(h => h.motivation === 'highlighting')).toBe(true);
    });

    it('getHighlights() should filter by resourceId', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestHighlight(resource1['@id']));
      await db.createAnnotation(createTestHighlight(resource2['@id']));

      const highlights = await db.getHighlights(uriToResourceId(resource1['@id']));

      expect(highlights).toHaveLength(1);
    });

    it('getHighlights() should return empty array when none exist', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      const highlights = await db.getHighlights(uriToResourceId(resource['@id']));

      expect(highlights).toEqual([]);
    });
  });

  describe('Reference Operations', () => {
    it('resolveReference() should convert stub to SpecificResource', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      const input = createTestReference(resource1['@id']);
      const created = await db.createAnnotation(input);

      const resolved = await db.resolveReference(
        annotationId(created.id),
        uriToResourceId(resource2['@id'])
      );

      expect(resolved.body).toHaveProperty('source');
      expect((resolved.body as any).source).toBe(resource2['@id']);
    });

    it('resolveReference() should throw for non-existent annotation', async () => {
      await expect(
        db.resolveReference(annotationId('nonexistent'), resourceId('test'))
      ).rejects.toThrow();
    });

    it('getReferences() should return linking annotations', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestReference(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));
      await db.createAnnotation(createTestHighlight(resource['@id']));

      const references = await db.getReferences(uriToResourceId(resource['@id']));

      expect(references).toHaveLength(2);
      expect(references.every(r => r.motivation === 'linking')).toBe(true);
    });

    it('getReferences() should filter by resourceId', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestReference(resource1['@id']));
      await db.createAnnotation(createTestReference(resource2['@id']));

      const references = await db.getReferences(uriToResourceId(resource1['@id']));

      expect(references).toHaveLength(1);
    });

    it('getEntityReferences() should return entity-typed references', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id'], ['Person']));
      await db.createAnnotation(createTestReference(resource1['@id'])); // No entity types

      const entityRefs = await db.getEntityReferences(uriToResourceId(resource1['@id']));

      expect(entityRefs).toHaveLength(1);
    });

    it('getEntityReferences() should filter by entity types', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id'], ['Person']));
      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id'], ['Organization']));

      const personRefs = await db.getEntityReferences(uriToResourceId(resource1['@id']), ['Person']);

      expect(personRefs).toHaveLength(1);
    });

    it('getResourceAnnotations() should return all annotations for resource', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));

      const annotations = await db.getResourceAnnotations(uriToResourceId(resource['@id']));

      expect(annotations).toHaveLength(2);
    });

    it('getResourceReferencedBy() should find reverse references', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      const input = createTestEntityReference(resource1['@id'], resource2['@id']);
      await db.createAnnotation(input);

      const reverseRefs = await db.getResourceReferencedBy(resourceUri(resource2['@id']));

      expect(reverseRefs).toHaveLength(1);
    });
  });

  describe('Graph Traversal', () => {
    it('getResourceConnections() should find connected resources', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      const ref = createTestEntityReference(resource1['@id'], resource2['@id']);
      await db.createAnnotation(ref);

      const connections = await db.getResourceConnections(uriToResourceId(resource1['@id']));

      expect(connections).toHaveLength(1);
      expect(connections[0]?.targetResource['@id']).toBe(resource2['@id']);
    });

    it('getResourceConnections() should detect bidirectional links', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      await db.createResource(resource1);
      await db.createResource(resource2);

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id']));
      await db.createAnnotation(createTestEntityReference(resource2['@id'], resource1['@id']));

      const connections = await db.getResourceConnections(uriToResourceId(resource1['@id']));

      expect(connections[0]?.bidirectional).toBe(true);
    });

    it('findPath() should find shortest path between resources', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      const resource3 = createTestResource();

      await db.createResource(resource1);
      await db.createResource(resource2);
      await db.createResource(resource3);

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id']));
      await db.createAnnotation(createTestEntityReference(resource2['@id'], resource3['@id']));

      const paths = await db.findPath(resource1['@id'] as any, resource3['@id'] as any);

      expect(paths.length).toBeGreaterThan(0);
      expect(paths[0]?.resources).toHaveLength(3);
    });

    it('findPath() should respect maxDepth limit', async () => {
      const resource1 = createTestResource();
      const resource2 = createTestResource();
      const resource3 = createTestResource();

      await db.createResource(resource1);
      await db.createResource(resource2);
      await db.createResource(resource3);

      await db.createAnnotation(createTestEntityReference(resource1['@id'], resource2['@id']));
      await db.createAnnotation(createTestEntityReference(resource2['@id'], resource3['@id']));

      const paths = await db.findPath(resource1['@id'] as any, resource3['@id'] as any, 1);

      expect(paths).toHaveLength(0);
    });
  });

  describe('Analytics', () => {
    it('getEntityTypeStats() should count resources by entity type', async () => {
      await db.createResource(createTestResource({ entityTypes: ['Person'] }));
      await db.createResource(createTestResource({ entityTypes: ['Person'] }));
      await db.createResource(createTestResource({ entityTypes: ['Organization'] }));

      const stats = await db.getEntityTypeStats();

      const personStat = stats.find(s => s.type === 'Person');
      const orgStat = stats.find(s => s.type === 'Organization');

      expect(personStat?.count).toBe(2);
      expect(orgStat?.count).toBe(1);
    });

    it('getStats() should return comprehensive statistics', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));

      const stats = await db.getStats();

      expect(stats.resourceCount).toBe(1);
      expect(stats.annotationCount).toBe(2);
      expect(stats.highlightCount).toBe(1);
      expect(stats.referenceCount).toBe(1);
    });

    it('getStats() should count by motivation (highlights vs references)', async () => {
      const resource = createTestResource();
      await db.createResource(resource);

      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestHighlight(resource['@id']));
      await db.createAnnotation(createTestReference(resource['@id']));

      const stats = await db.getStats();

      expect(stats.highlightCount).toBe(2);
      expect(stats.referenceCount).toBe(1);
    });

    it('getStats() should aggregate content types', async () => {
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
          mediaType: 'text/markdown',
          content: { value: 'test' },
        }],
      }));

      const stats = await db.getStats();

      expect(stats.contentTypes['text/plain']).toBe(1);
      expect(stats.contentTypes['text/markdown']).toBe(1);
    });
  });

  describe('Tag Collections', () => {
    it('getEntityTypes() should return sorted list', async () => {
      await db.addEntityType('Zebra');
      await db.addEntityType('Apple');
      await db.addEntityType('Mango');

      const types = await db.getEntityTypes();

      expect(types[0]).toBe('Apple');
      expect(types.indexOf('Mango')).toBeGreaterThan(types.indexOf('Apple'));
      expect(types.indexOf('Zebra')).toBeGreaterThan(types.indexOf('Mango'));
    });

    it('addEntityType() should add new type', async () => {
      await db.addEntityType('CustomType');

      const types = await db.getEntityTypes();

      expect(types).toContain('CustomType');
    });

    it('addEntityTypes() should batch add types', async () => {
      await db.addEntityTypes(['Type1', 'Type2', 'Type3']);

      const types = await db.getEntityTypes();

      expect(types).toContain('Type1');
      expect(types).toContain('Type2');
      expect(types).toContain('Type3');
    });
  });

  describe('Utility Methods', () => {
    it('generateId() should create unique identifiers', () => {
      const id1 = db.generateId();
      const id2 = db.generateId();

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id1.length).toBeGreaterThan(0);
    });

    it('clearDatabase() should remove all data', async () => {
      await db.createResource(createTestResource());
      const resource = createTestResource();
      await db.createResource(resource);
      await db.createAnnotation(createTestHighlight(resource['@id']));

      await db.clearDatabase();

      const stats = await db.getStats();
      expect(stats.resourceCount).toBe(0);
      expect(stats.annotationCount).toBe(0);
    });
  });
});
