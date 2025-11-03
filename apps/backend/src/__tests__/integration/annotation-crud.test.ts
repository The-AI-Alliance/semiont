/**
 * Integration tests for Annotation CRUD operations
 * Tests multi-body arrays with TextualBody (tagging) and SpecificResource (linking)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { components } from '@semiont/api-client';
import type { ResourceCreatedEvent } from '@semiont/core';
import { resourceId, userId, annotationId } from '@semiont/core';
import { CREATION_METHODS } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];
import { createEventStore } from '../../services/event-store-service';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { getFilesystemConfig } from '../../config/config';

describe('Annotation CRUD Integration Tests - W3C multi-body annotation', () => {
  let testBasePath: string;
  const testDocId = resourceId('test-doc-integration-' + Date.now());
  const testDocId2 = resourceId('test-doc-target-' + Date.now());

  beforeAll(async () => {
    // Use the filesystem path configured by global test setup
    // This ensures EventStore and AnnotationQueryService use the SAME path
    testBasePath = getFilesystemConfig().path;

    // Create test resources in event store
    const eventStore = await createEventStore(testBasePath);

    const docEvent1: Omit<ResourceCreatedEvent, 'id' | 'timestamp'> = {
      type: 'resource.created',
      resourceId: testDocId,
      userId: userId('test-user'),
      version: 1,
      payload: {
        name: 'Test Resource for CRUD',
        format: 'text/plain',
        contentChecksum: 'test-checksum-1',
        creationMethod: CREATION_METHODS.API,
      },
    };

    const docEvent2: Omit<ResourceCreatedEvent, 'id' | 'timestamp'> = {
      type: 'resource.created',
      resourceId: testDocId2,
      userId: userId('test-user'),
      version: 1,
      payload: {
        name: 'Test Target Resource',
        format: 'text/plain',
        contentChecksum: 'test-checksum-2',
        creationMethod: CREATION_METHODS.API,
      },
    };

    await eventStore.appendEvent(docEvent1);
    await eventStore.appendEvent(docEvent2);

    // Wait for projection
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  // Cleanup handled by global test setup

  describe('Create Annotation with Entity Tags (stub reference)', () => {
    it('should create annotation with empty body array', async () => {
      // Use SAME path from beforeAll
      const eventStore = await createEventStore(testBasePath);

      const annotation: Omit<Annotation, 'creator' | 'created'> = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-empty-body-' + Date.now(),
        motivation: 'linking',
        target: {
          source: testDocId,
          selector: [
            {
              type: 'TextPositionSelector',
              start: 0,
              end: 9,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'test text',
            },
          ],
        },
        body: [], // Empty array for stub
        modified: new Date().toISOString(),
      };

      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: { annotation },
      });

      // Wait for projection
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify annotation was created
      const retrieved = await AnnotationQueryService.getAnnotation(annotationId(annotation.id), testDocId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(annotation.id);
      expect(Array.isArray(retrieved?.body)).toBe(true);
      expect((retrieved?.body as any[]).length).toBe(0);
    });

    it('should create annotation with TextualBody entity tags', async () => {
      // Use SAME path from beforeAll
      const eventStore = await createEventStore(testBasePath);

      const annotation: Omit<Annotation, 'creator' | 'created'> = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: 'test-entity-tags-' + Date.now(),
        motivation: 'linking',
        target: {
          source: testDocId,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'Albert Einstein',
          },
        },
        body: [
          {
            type: 'TextualBody',
            value: 'Person',
            purpose: 'tagging',
          },
          {
            type: 'TextualBody',
            value: 'Scientist',
            purpose: 'tagging',
          },
          {
            type: 'TextualBody',
            value: 'Physicist',
            purpose: 'tagging',
          },
        ],
        modified: new Date().toISOString(),
      };

      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: { annotation },
      });

      // Wait for projection
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify annotation was created with entity tags
      const retrieved = await AnnotationQueryService.getAnnotation(annotationId(annotation.id), testDocId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(annotation.id);
      expect(Array.isArray(retrieved?.body)).toBe(true);

      if (Array.isArray(retrieved?.body)) {
        expect(retrieved.body.length).toBe(3);

        // Verify all are TextualBody with purpose: "tagging"
        const tagBodies = retrieved.body.filter(
          b => b.type === 'TextualBody' && 'purpose' in b && b.purpose === 'tagging'
        );
        expect(tagBodies.length).toBe(3);

        // Verify entity type values
        const values = tagBodies.map(b => ('value' in b ? b.value : '')).filter(Boolean);
        expect(values).toContain('Person');
        expect(values).toContain('Scientist');
        expect(values).toContain('Physicist');
      }
    });
  });

  describe('Resolve Annotation (add SpecificResource)', () => {
    it('should add SpecificResource to existing entity tags', async () => {
      // Use SAME path from beforeAll
      const eventStore = await createEventStore(testBasePath);

      // Create stub annotation with entity tags
      const stubId = annotationId('test-resolve-stub-' + Date.now());
      const stubAnnotation: Omit<Annotation, 'creator' | 'created'> = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: stubId,
        motivation: 'linking',
        target: {
          source: testDocId,
          selector: [
            {
              type: 'TextPositionSelector',
              start: 0,
              end: 17,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'quantum mechanics',
            },
          ],
        },
        body: [
          {
            type: 'TextualBody',
            value: 'Concept',
            purpose: 'tagging',
          },
        ],
        modified: new Date().toISOString(),
      };

      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: { annotation: stubAnnotation },
      });

      // Wait for projection
      await new Promise(resolve => setTimeout(resolve, 100));

      // Resolve annotation (add SpecificResource)
      await eventStore.appendEvent({
        type: 'annotation.body.updated',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: {
          annotationId: stubId,
          operations: [{
            op: 'add',
            item: {
              type: 'SpecificResource',
              source: testDocId2,
              purpose: 'linking',
            },
          }],
        },
      });

      // Wait for projection
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify resolved annotation has both entity tags and SpecificResource
      const resolved = await AnnotationQueryService.getAnnotation(stubId, testDocId);
      expect(resolved).toBeDefined();
      expect(Array.isArray(resolved?.body)).toBe(true);

      if (Array.isArray(resolved?.body)) {
        // Should have 2 bodies: 1 TextualBody + 1 SpecificResource
        expect(resolved.body.length).toBe(2);

        // Verify TextualBody entity tag is preserved
        const tagBodies = resolved.body.filter(
          b => b.type === 'TextualBody' && 'purpose' in b && b.purpose === 'tagging'
        );
        expect(tagBodies.length).toBe(1);
        const tagBody = tagBodies[0];
        if (tagBody && 'value' in tagBody) {
          expect(tagBody.value).toBe('Concept');
        }

        // Verify SpecificResource was added
        const specificResources = resolved.body.filter(b => b.type === 'SpecificResource');
        expect(specificResources.length).toBe(1);
        const sr = specificResources[0];
        if (sr && 'source' in sr) {
          expect(sr.source).toBe(testDocId2);
        }
        if (sr && 'purpose' in sr) {
          expect(sr.purpose).toBe('linking');
        }
      }
    });

    it('should resolve annotation with empty body to have only SpecificResource', async () => {
      // Use SAME path from beforeAll
      const eventStore = await createEventStore(testBasePath);

      // Create stub with empty body
      const stubId = annotationId('test-resolve-empty-' + Date.now());
      const stubAnnotation: Omit<Annotation, 'creator' | 'created'> = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: stubId,
        motivation: 'linking',
        target: {
          source: testDocId,
          selector: [
            {
              type: 'TextPositionSelector',
              start: 0,
              end: 14,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'reference text',
            },
          ],
        },
        body: [],
        modified: new Date().toISOString(),
      };

      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: { annotation: stubAnnotation },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Resolve
      await eventStore.appendEvent({
        type: 'annotation.body.updated',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: {
          annotationId: stubId,
          operations: [{
            op: 'add',
            item: {
              type: 'SpecificResource',
              source: testDocId2,
              purpose: 'linking',
            },
          }],
        },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify has only SpecificResource
      const resolved = await AnnotationQueryService.getAnnotation(stubId, testDocId);
      expect(resolved).toBeDefined();
      expect(Array.isArray(resolved?.body)).toBe(true);

      if (Array.isArray(resolved?.body)) {
        expect(resolved.body.length).toBe(1);
        expect(resolved.body[0]?.type).toBe('SpecificResource');
      }
    });
  });

  describe('List Annotations with Multi-Body', () => {
    it('should list all annotations with proper body structure', async () => {
      const annotations = await AnnotationQueryService.getAllAnnotations(testDocId);

      expect(Array.isArray(annotations)).toBe(true);
      expect(annotations.length).toBeGreaterThan(0);

      // Verify each annotation has proper body structure
      for (const annotation of annotations) {
        expect(annotation).toHaveProperty('body');

        // Body should be array in W3C multi-body annotation
        if (annotation.body !== null && annotation.body !== undefined) {
          expect(Array.isArray(annotation.body)).toBe(true);

          if (Array.isArray(annotation.body)) {
            // Each body item should have a type
            for (const bodyItem of annotation.body) {
              expect(bodyItem).toHaveProperty('type');
              expect(['TextualBody', 'SpecificResource']).toContain(bodyItem.type);

              // TextualBody should have value and purpose
              if (bodyItem.type === 'TextualBody') {
                expect(bodyItem).toHaveProperty('value');
                expect(bodyItem).toHaveProperty('purpose');
              }

              // SpecificResource should have source
              if (bodyItem.type === 'SpecificResource') {
                expect(bodyItem).toHaveProperty('source');
              }
            }
          }
        }
      }
    });
  });

  describe('Delete Annotation', () => {
    it('should delete annotation with multi-body', async () => {
      // Use SAME path from beforeAll
      const eventStore = await createEventStore(testBasePath);

      // Create annotation
      const deleteId = annotationId('test-delete-' + Date.now());
      const annotation: Omit<Annotation, 'creator' | 'created'> = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: deleteId,
        motivation: 'linking',
        target: {
          source: testDocId,
          selector: [
            {
              type: 'TextPositionSelector',
              start: 0,
              end: 9,
            },
            {
              type: 'TextQuoteSelector',
              exact: 'delete me',
            },
          ],
        },
        body: [
          {
            type: 'TextualBody',
            value: 'ToDelete',
            purpose: 'tagging',
          },
          {
            type: 'SpecificResource',
            source: testDocId2,
            purpose: 'linking',
          },
        ],
        modified: new Date().toISOString(),
      };

      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: { annotation },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify it exists
      const beforeDelete = await AnnotationQueryService.getAnnotation(deleteId, testDocId);
      expect(beforeDelete).toBeDefined();

      // Delete
      await eventStore.appendEvent({
        type: 'annotation.removed',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: {
          annotationId: deleteId,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify it's deleted
      const afterDelete = await AnnotationQueryService.getAnnotation(deleteId, testDocId);
      expect(afterDelete).toBeNull();
    });
  });

  describe('W3C Compliance in Integration', () => {
    it('should maintain W3C structure through event sourcing', async () => {
      // Use SAME path from beforeAll
      const eventStore = await createEventStore(testBasePath);

      const w3cId = 'test-w3c-' + Date.now();
      const annotation: Omit<Annotation, 'creator' | 'created'> = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        'type': 'Annotation',
        id: w3cId,
        motivation: 'linking',
        target: {
          source: testDocId,
          selector: {
            type: 'TextQuoteSelector',
            exact: 'W3C test',
          },
        },
        body: [
          {
            type: 'TextualBody',
            value: 'TestEntity',
            purpose: 'tagging',
          },
        ],
        modified: new Date().toISOString(),
      };

      await eventStore.appendEvent({
        type: 'annotation.added',
        resourceId: testDocId,
        userId: userId('test-user'),
        version: 1,
        payload: { annotation },
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const retrieved = await AnnotationQueryService.getAnnotation(annotationId(w3cId), testDocId);

      // Verify W3C required fields
      expect(retrieved).toBeDefined();
      expect(retrieved?.['@context']).toBe('http://www.w3.org/ns/anno.jsonld');
      expect(retrieved?.type).toBe('Annotation');
      expect(retrieved?.id).toBe(w3cId);
      expect(retrieved?.motivation).toBe('linking');
      expect(retrieved?.target).toBeDefined();
      expect(retrieved?.body).toBeDefined();
    });
  });
});
