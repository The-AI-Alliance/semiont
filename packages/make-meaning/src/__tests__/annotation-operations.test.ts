/**
 * Annotation Operations Tests
 *
 * Tests critical business logic for annotation CRUD operations including:
 * - Annotation creation (ID generation, validation, W3C structure, event emission)
 * - Annotation updates (body operations: add/remove/replace)
 * - Annotation deletion (validation, event emission)
 * - W3C Annotation Model compliance
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { AnnotationOperations } from '../annotation-operations';
import { ResourceOperations } from '../resource-operations';
import { resourceId, userId, annotationId, EventBus, type Logger } from '@semiont/core';
import type { components } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import type { KnowledgeBase } from '../knowledge-base';
import { Stower } from '../stower';
import { getGraphDatabase } from '@semiont/graph';
import type { GraphServiceConfig } from '@semiont/core';
import { createTestProject } from './helpers/test-project';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

/**
 * Create an annotation and await Stower persistence.
 * Subscribes to mark:created BEFORE emitting, then filters by annotation ID.
 */
async function createAnnotationAndAwait(
  request: CreateAnnotationRequest,
  uid: ReturnType<typeof userId>,
  eventBus: EventBus,
) {
  const creator = { type: 'Person' as const, id: 'did:web:test.local:users:test-user', name: 'Test User' };
  const result = await AnnotationOperations.createAnnotation(request, uid, creator, eventBus);
  // Wait for THIS annotation's mark:created (filter by ID to avoid picking up a stale event)
  const expectedId = annotationId(result.annotation.id);
  await firstValueFrom(eventBus.get('mark:create-ok').pipe(
    filter(e => e.annotationId === expectedId),
    take(1),
  ));
  return result;
}


const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('AnnotationOperations', () => {
  let teardown: () => Promise<void>;
  let testEventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let kb: KnowledgeBase;
  let testResourceId: string;

  beforeAll(async () => {
    const { project, teardown: td } = await createTestProject('annotation-ops');
    teardown = td;

    // Initialize EventBus and stores
    eventBus = new EventBus();
    testEventStore = createEventStore(project, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    const { WorkingTreeStore } = await import('@semiont/content');
    const repStore = new WorkingTreeStore(project, mockLogger);
    kb = { eventStore: testEventStore, views: testEventStore.viewStorage, content: repStore, graph: graphDb, projectionsDir: project.projectionsDir, graphConsumer: {} as any };

    stower = new Stower(kb, eventBus, mockLogger);
    await stower.initialize();

    // Create a test resource for annotations
    const content = Buffer.from('This is test content for annotations. It has multiple sentences. We will annotate various parts.', 'utf-8');
    const resId = await ResourceOperations.createResource(
      {
        name: 'Annotation Test Resource',
        content,
        format: 'text/plain',
      },
      userId('user-1'),
      eventBus,
    );

    testResourceId = resId;
  });

  afterAll(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('createAnnotation', () => {
    it('should create annotation with motivation: highlighting', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      expect(result.annotation).toBeDefined();
      expect(result.annotation.motivation).toBe('highlighting');
      expect(result.annotation.id).toBeDefined();
      expect(typeof result.annotation.id).toBe('string');
      expect(result.annotation.id.length).toBeGreaterThan(0);
    });

    it('should create annotation with motivation: commenting', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'commenting',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      expect(result.annotation.motivation).toBe('commenting');
      expect(result.annotation.body).toMatchObject({
        type: 'TextualBody',
        value: 'This needs clarification',
      });
    });

    it('should create annotation with motivation: assessing', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'assessing',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      expect(result.annotation.motivation).toBe('assessing');
    });

    it('should create annotation with motivation: tagging', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'tagging',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      expect(result.annotation.motivation).toBe('tagging');
      expect(Array.isArray(result.annotation.body)).toBe(true);
      expect((result.annotation.body as any[]).length).toBe(2);
    });

    it('should create annotation with motivation: linking', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'linking',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      expect(result.annotation.motivation).toBe('linking');
    });

    it('should validate W3C annotation structure', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'commenting',
          target: {
            source: testResourceId,
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
        eventBus,
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
      const result = await createAnnotationAndAwait(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      // Check event was emitted
      const events = await testEventStore.log.getEvents(resourceId(testResourceId));
      const addedEvents = events.filter(e => e.type === 'mark:added');
      expect(addedEvents.length).toBeGreaterThan(0);

      // Find the event for this specific annotation
      const thisAnnotationEvent = addedEvents.find(
        e => e.type === 'mark:added' && e.payload.annotation.id === result.annotation.id
      );
      expect(thisAnnotationEvent).toBeDefined();
      expect(thisAnnotationEvent).toMatchObject({
        type: 'mark:added',
        resourceId: resourceId(testResourceId),
        userId: userId('user-1'),
      });
    });

    it('should generate annotation ID', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'commenting',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      expect(result.annotation.id).toBeDefined();
      expect(typeof result.annotation.id).toBe('string');
      expect(result.annotation.id.length).toBeGreaterThan(0);
    });

    it('should handle text position selector', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      const target = result.annotation.target;
      if (typeof target !== 'string' && 'selector' in target) {
        const selector = target.selector;
        expect(Array.isArray(selector)).toBe(true);
        const posSelector = (selector as any[]).find(s => s.type === 'TextPositionSelector');
        expect(posSelector).toBeDefined();
        expect(posSelector.start).toBe(5);
        expect(posSelector.end).toBe(15);
      }
    });

    it('should handle text quote selector', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'highlighting',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      const target = result.annotation.target;
      if (typeof target !== 'string' && 'selector' in target) {
        const selector = target.selector;
        const quoteSelector = (selector as any[]).find(s => s.type === 'TextQuoteSelector');
        expect(quoteSelector).toBeDefined();
        expect(quoteSelector.exact).toBe('This');
      }
    });

    it('should reject invalid motivation', async () => {
      const creator = { type: 'Person' as const, id: 'did:web:test.local:users:test-user', name: 'Test User' };
      await expect(
        AnnotationOperations.createAnnotation(
          {
            motivation: undefined as any,
            target: {
              source: testResourceId,
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
          creator,
          eventBus,
        )
      ).rejects.toThrow('motivation is required');
    });

    it('should reject missing text position selector', async () => {
      const creator = { type: 'Person' as const, id: 'did:web:test.local:users:test-user', name: 'Test User' };
      await expect(
        AnnotationOperations.createAnnotation(
          {
            motivation: 'commenting',
            target: {
              source: testResourceId,
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
          creator,
          eventBus,
        )
      ).rejects.toThrow('Either TextPositionSelector, SvgSelector, or FragmentSelector is required');
    });
  });

  describe('updateAnnotationBody', () => {
    it('should update annotation body with add operation', async () => {
      // First create an annotation and await Stower persistence
      const createResult = await createAnnotationAndAwait(
        {
          motivation: 'tagging',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Update with add operation — await mark:body-updated so the Stower finishes
      // writing the view before the next test starts (prevents concurrent view writes)
      const bodyUpdated$ = firstValueFrom(eventBus.get('mark:body-updated').pipe(take(1)));

      const result = await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceId,
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
        eventBus,
        kb
      );

      await bodyUpdated$;

      expect(Array.isArray(result.annotation.body)).toBe(true);
      expect((result.annotation.body as any[]).length).toBe(2);
    });

    it('should update annotation body with remove operation', async () => {
      // Create annotation with multiple tags and await Stower persistence
      const createResult = await createAnnotationAndAwait(
        {
          motivation: 'tagging',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Remove one tag — await mark:body-updated to prevent concurrent view writes
      const bodyUpdated$ = firstValueFrom(eventBus.get('mark:body-updated').pipe(take(1)));

      const result = await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceId,
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
        eventBus,
        kb
      );

      await bodyUpdated$;

      expect((result.annotation.body as any[]).length).toBe(1);
      expect((result.annotation.body as any[])[0].value).toBe('remove2');
    });

    it('should update annotation body with replace operation', async () => {
      // Create annotation and await Stower persistence
      const createResult = await createAnnotationAndAwait(
        {
          motivation: 'tagging',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Replace tag — await mark:body-updated to prevent concurrent view writes
      const bodyUpdated$ = firstValueFrom(eventBus.get('mark:body-updated').pipe(take(1)));

      const result = await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceId,
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
        eventBus,
        kb
      );

      await bodyUpdated$;

      expect((result.annotation.body as any[])[0].value).toBe('new-tag');
    });

    it('should emit annotation.body.updated event', async () => {
      // Create annotation and await Stower persistence
      const createResult = await createAnnotationAndAwait(
        {
          motivation: 'tagging',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      const annotationIdStr = createResult.annotation.id.split('/').pop()!;

      // Update and await Stower persistence
      const bodyUpdated$ = firstValueFrom(eventBus.get('mark:body-updated').pipe(take(1)));
      await AnnotationOperations.updateAnnotationBody(
        annotationIdStr,
        {
          resourceId: testResourceId,
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
        eventBus,
        kb
      );
      await bodyUpdated$;

      // Check event
      const events = await testEventStore.log.getEvents(resourceId(testResourceId));
      const updatedEvents = events.filter(e => e.type === 'mark:body-updated');
      expect(updatedEvents.length).toBeGreaterThan(0);
    });

    it('should handle non-existent annotation', async () => {
      await expect(
        AnnotationOperations.updateAnnotationBody(
          'non-existent-annotation',
          {
            resourceId: testResourceId,
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
          eventBus,
          kb
        )
      ).rejects.toThrow('Annotation not found');
    });
  });

  describe('deleteAnnotation', () => {
    it('should emit annotation.removed event', async () => {
      // Create annotation to delete and await Stower persistence
      const createResult = await createAnnotationAndAwait(
        {
          motivation: 'commenting',
          target: {
            source: testResourceId,
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
        eventBus,
      );

      const annotationIdStr = createResult.annotation.id;

      // Delete and await Stower persistence
      const deleted$ = firstValueFrom(eventBus.get('mark:delete-ok').pipe(take(1)));
      await AnnotationOperations.deleteAnnotation(
        annotationIdStr,
        testResourceId,
        userId('user-1'),
        eventBus,
        kb
      );
      await deleted$;

      // Check event
      const events = await testEventStore.log.getEvents(resourceId(testResourceId));
      const removedEvents = events.filter(e => e.type === 'mark:removed');
      expect(removedEvents.length).toBeGreaterThan(0);
    });

    it('should handle already deleted annotation', async () => {
      await expect(
        AnnotationOperations.deleteAnnotation(
          'non-existent',
          testResourceId,
          userId('user-1'),
          eventBus,
          kb
        )
      ).rejects.toThrow('Annotation not found in resource');
    });
  });
});
