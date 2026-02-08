/**
 * Annotation Operations Tests
 *
 * Tests critical business logic for annotation CRUD operations including:
 * - Annotation creation (ID generation, validation, W3C structure, event emission)
 * - Annotation updates (body operations: add/remove/replace)
 * - Annotation deletion (validation, event emission)
 * - W3C Annotation Model compliance
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AnnotationOperations } from '../annotation-operations';
import { ResourceOperations } from '../resource-operations';
import { resourceId, userId, type EnvironmentConfig } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore, type RepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('AnnotationOperations', () => {
  let testDir: string;
  let testEventStore: EventStore;
  let testRepStore: RepresentationStore;
  let config: EnvironmentConfig;
  let testResourceUri: string;
  let testResourceId: string;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-annotation-ops-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration
    config = {
      services: {
        filesystem: {
          platform: { type: 'posix' },
          path: testDir
        },
        backend: {
          platform: { type: 'posix' },
          port: 4000,
          publicURL: 'http://localhost:4000',
          corsOrigin: 'http://localhost:3000'
        },
        inference: {
          platform: { type: 'external' },
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          endpoint: 'https://api.anthropic.com',
          apiKey: 'test-api-key'
        },
        graph: {
          platform: { type: 'posix' },
          type: 'memory'
        }
      },
      site: {
        siteName: 'Test Site',
        domain: 'localhost:3000',
        adminEmail: 'admin@test.local',
        oauthAllowedDomains: ['test.local']
      },
      _metadata: {
        environment: 'test',
        projectRoot: testDir
      },
    } as EnvironmentConfig;

    // Initialize stores
    testEventStore = createEventStore(testDir, config.services.backend!.publicURL);
    testRepStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);

    // Create a test resource for annotations
    const content = Buffer.from('This is test content for annotations. It has multiple sentences. We will annotate various parts.', 'utf-8');
    const response = await ResourceOperations.createResource(
      {
        name: 'Annotation Test Resource',
        content,
        format: 'text/plain',
      },
      userId('user-1'),
      testEventStore,
      testRepStore,
      config
    );

    testResourceUri = response.resource['@id'];
    const idMatch = testResourceUri.match(/\/resources\/(.+)$/);
    testResourceId = idMatch![1];
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('createAnnotation', () => {
    it('should create annotation with motivation: highlighting', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 0,
                end: 21,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'Important passage',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect(result.annotation).toBeDefined();
      expect(result.annotation.motivation).toBe('highlighting');
      expect(result.annotation.id).toMatch(/^http:\/\/localhost:4000\/annotations\//);
    });

    it('should create annotation with motivation: commenting', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'commenting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 22,
                end: 44,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'This needs clarification',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect(result.annotation.motivation).toBe('commenting');
      expect(result.annotation.body).toMatchObject({
        type: 'TextualBody',
        value: 'This needs clarification',
      });
    });

    it('should create annotation with motivation: assessing', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'assessing',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 45,
                end: 78,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'This claim requires evidence',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect(result.annotation.motivation).toBe('assessing');
    });

    it('should create annotation with motivation: tagging', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'tagging',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 0,
                end: 10,
              },
            ],
          },
          body: [
            {
              type: 'TextualBody',
              value: 'important',
              purpose: 'tagging',
            },
            {
              type: 'TextualBody',
              value: 'review',
              purpose: 'tagging',
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect(result.annotation.motivation).toBe('tagging');
      expect(Array.isArray(result.annotation.body)).toBe(true);
      expect((result.annotation.body as any[]).length).toBe(2);
    });

    it('should create annotation with motivation: linking', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'linking',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 50,
                end: 60,
              },
            ],
          },
          body: {
            type: 'SpecificResource',
            source: 'http://example.com/related-resource',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect(result.annotation.motivation).toBe('linking');
    });

    it('should validate W3C annotation structure', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'commenting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 0,
                end: 10,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'Test comment',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      // Verify W3C annotation structure
      expect(result.annotation['@context']).toBe('http://www.w3.org/ns/anno.jsonld');
      expect(result.annotation.type).toBe('Annotation');
      expect(result.annotation.id).toBeDefined();
      expect(result.annotation.motivation).toBeDefined();
      expect(result.annotation.target).toBeDefined();
      expect(result.annotation.body).toBeDefined();
      expect(result.annotation.created).toBeDefined();
      expect(result.annotation.modified).toBeDefined();
    });

    it('should emit annotation.added event', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 10,
                end: 20,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'Highlight',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      // Check event was emitted
      const events = await testEventStore.log.getEvents(resourceId(testResourceId));
      const addedEvents = events.filter(e => e.event.type === 'annotation.added');
      expect(addedEvents.length).toBeGreaterThan(0);

      // Find the event for this specific annotation
      const thisAnnotationEvent = addedEvents.find(
        e => e.event.payload.annotation.id === result.annotation.id
      );
      expect(thisAnnotationEvent).toBeDefined();
      expect(thisAnnotationEvent!.event).toMatchObject({
        type: 'annotation.added',
        resourceId: resourceId(testResourceId),
        userId: userId('user-1'),
      });
    });

    it('should generate annotation ID', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'commenting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 30,
                end: 40,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'Comment',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect(result.annotation.id).toBeDefined();
      expect(result.annotation.id).toMatch(/^http:\/\/localhost:4000\/annotations\//);
    });

    it('should handle text position selector', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 5,
                end: 15,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'Position test',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      const selector = result.annotation.target.selector;
      expect(Array.isArray(selector)).toBe(true);
      const posSelector = (selector as any[]).find(s => s.type === 'TextPositionSelector');
      expect(posSelector).toBeDefined();
      expect(posSelector.start).toBe(5);
      expect(posSelector.end).toBe(15);
    });

    it('should handle text quote selector', async () => {
      const result = await AnnotationOperations.createAnnotation(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 0,
                end: 4,
              },
              {
                type: 'TextQuoteSelector',
                exact: 'This',
                prefix: '',
                suffix: ' is test',
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'Quote test',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      const selector = result.annotation.target.selector;
      const quoteSelector = (selector as any[]).find(s => s.type === 'TextQuoteSelector');
      expect(quoteSelector).toBeDefined();
      expect(quoteSelector.exact).toBe('This');
    });

    it('should reject invalid motivation', async () => {
      await expect(
        AnnotationOperations.createAnnotation(
          {
            motivation: undefined as any,
            target: {
              source: testResourceUri,
              selector: [
                {
                  type: 'TextPositionSelector',
                  start: 0,
                  end: 10,
                },
              ],
            },
            body: {
              type: 'TextualBody',
              value: 'Test',
              format: 'text/plain',
            },
          },
          userId('user-1'),
          testEventStore,
          config
        )
      ).rejects.toThrow('motivation is required');
    });

    it('should reject missing text position selector', async () => {
      await expect(
        AnnotationOperations.createAnnotation(
          {
            motivation: 'commenting',
            target: {
              source: testResourceUri,
              selector: [
                {
                  type: 'TextQuoteSelector',
                  exact: 'test',
                } as any,
              ],
            },
            body: {
              type: 'TextualBody',
              value: 'Test',
              format: 'text/plain',
            },
          },
          userId('user-1'),
          testEventStore,
          config
        )
      ).rejects.toThrow('TextPositionSelector required');
    });
  });

  describe('updateAnnotationBody', () => {
    it('should update annotation body with add operation', async () => {
      // First create an annotation
      const createResult = await AnnotationOperations.createAnnotation(
        {
          motivation: 'tagging',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 0,
                end: 10,
              },
            ],
          },
          body: [
            {
              type: 'TextualBody',
              value: 'tag1',
              purpose: 'tagging',
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Update with add operation
      const result = await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceUri,
          operations: [
            {
              op: 'add',
              item: {
                type: 'TextualBody',
                value: 'tag2',
                purpose: 'tagging',
              },
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect(Array.isArray(result.annotation.body)).toBe(true);
      expect((result.annotation.body as any[]).length).toBe(2);
    });

    it('should update annotation body with remove operation', async () => {
      // Create annotation with multiple tags
      const createResult = await AnnotationOperations.createAnnotation(
        {
          motivation: 'tagging',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 20,
                end: 30,
              },
            ],
          },
          body: [
            {
              type: 'TextualBody',
              value: 'remove1',
              purpose: 'tagging',
            },
            {
              type: 'TextualBody',
              value: 'remove2',
              purpose: 'tagging',
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Remove one tag
      const result = await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceUri,
          operations: [
            {
              op: 'remove',
              item: {
                type: 'TextualBody',
                value: 'remove1',
                purpose: 'tagging',
              },
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect((result.annotation.body as any[]).length).toBe(1);
      expect((result.annotation.body as any[])[0].value).toBe('remove2');
    });

    it('should update annotation body with replace operation', async () => {
      // Create annotation
      const createResult = await AnnotationOperations.createAnnotation(
        {
          motivation: 'tagging',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 40,
                end: 50,
              },
            ],
          },
          body: [
            {
              type: 'TextualBody',
              value: 'old-tag',
              purpose: 'tagging',
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Replace tag
      const result = await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceUri,
          operations: [
            {
              op: 'replace',
              oldItem: {
                type: 'TextualBody',
                value: 'old-tag',
                purpose: 'tagging',
              },
              newItem: {
                type: 'TextualBody',
                value: 'new-tag',
                purpose: 'tagging',
              },
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      expect((result.annotation.body as any[])[0].value).toBe('new-tag');
    });

    it('should emit annotation.body.updated event', async () => {
      // Create annotation
      const createResult = await AnnotationOperations.createAnnotation(
        {
          motivation: 'tagging',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 60,
                end: 70,
              },
            ],
          },
          body: [
            {
              type: 'TextualBody',
              value: 'event-test',
              purpose: 'tagging',
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Update
      await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceUri,
          operations: [
            {
              op: 'add',
              item: {
                type: 'TextualBody',
                value: 'added-tag',
                purpose: 'tagging',
              },
            },
          ],
        },
        userId('user-1'),
        testEventStore,
        config
      );

      // Check event
      const events = await testEventStore.log.getEvents(resourceId(testResourceId));
      const updatedEvents = events.filter(e => e.event.type === 'annotation.body.updated');
      expect(updatedEvents.length).toBeGreaterThan(0);
    });

    it('should handle non-existent annotation', async () => {
      await expect(
        AnnotationOperations.updateAnnotationBody(
          'non-existent-annotation',
          {
            resourceId: testResourceUri,
            operations: [
              {
                op: 'add',
                item: {
                  type: 'TextualBody',
                  value: 'test',
                  purpose: 'tagging',
                },
              },
            ],
          },
          userId('user-1'),
          testEventStore,
          config
        )
      ).rejects.toThrow('Annotation not found');
    });
  });

  describe('deleteAnnotation', () => {
    it('should emit annotation.removed event', async () => {
      // Create annotation to delete
      const createResult = await AnnotationOperations.createAnnotation(
        {
          motivation: 'commenting',
          target: {
            source: testResourceUri,
            selector: [
              {
                type: 'TextPositionSelector',
                start: 70,
                end: 80,
              },
            ],
          },
          body: {
            type: 'TextualBody',
            value: 'To be deleted',
            format: 'text/plain',
          },
        },
        userId('user-1'),
        testEventStore,
        config
      );

      const annotationIdStr = createResult.annotation.id;

      // Delete
      await AnnotationOperations.deleteAnnotation(
        annotationIdStr,
        testResourceUri,
        userId('user-1'),
        testEventStore,
        config
      );

      // Check event
      const events = await testEventStore.log.getEvents(resourceId(testResourceId));
      const removedEvents = events.filter(e => e.event.type === 'annotation.removed');
      expect(removedEvents.length).toBeGreaterThan(0);
    });

    it('should handle already deleted annotation', async () => {
      await expect(
        AnnotationOperations.deleteAnnotation(
          'http://localhost:4000/annotations/non-existent',
          testResourceUri,
          userId('user-1'),
          testEventStore,
          config
        )
      ).rejects.toThrow('Annotation not found');
    });
  });
});
