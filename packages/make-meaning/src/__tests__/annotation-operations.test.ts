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
import { promises as fs } from 'fs';
import { join } from 'path';
import { AnnotationOperations } from '../annotation-operations';
import { ResourceOperations } from '../resource-operations';
import { resourceId, userId, EventBus, type Logger, type SupportedMediaType } from '@semiont/core';
import type { components } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import type { KnowledgeBase } from '../knowledge-base';
import { Stower } from '../stower';
import { getGraphDatabase } from '@semiont/graph';
import { deriveStorageUri } from '@semiont/content';
import type { GraphServiceConfig } from '@semiont/core';
import { createTestProject } from './helpers/test-project';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

/**
 * Create an annotation and await Stower persistence.
 *
 * These tests bypass the `mark:create-request` → annotation-assembly
 * pipeline and emit `mark:create` directly, so `mark:create-ok` (emitted
 * only by annotation-assembly on observing `mark:added`) is never fired.
 * The right completion signal for the direct-emit path is the persisted
 * `mark:added` domain event published by Stower after appendEvent.
 */
async function createAnnotationAndAwait(
  request: CreateAnnotationRequest,
  uid: ReturnType<typeof userId>,
  eventBus: EventBus,
) {
  const creator = { '@type': 'Person' as const, '@id': 'did:web:test.local:users:test-user', name: 'Test User' };
  const result = await AnnotationOperations.createAnnotation(request, uid, creator, eventBus);
  const expectedId = result.annotation.id;
  await firstValueFrom(eventBus.get('mark:added').pipe(
    filter((e) => e.payload?.annotation?.id === expectedId),
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

let fileCounter = 0;

describe('AnnotationOperations', () => {
  let teardown: () => Promise<void>;
  let testEventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let kb: KnowledgeBase;
  let testResourceId: string;
  let suiteProject: Awaited<ReturnType<typeof createTestProject>>['project'];

  async function create(
    opts: { name: string; content: Buffer; format: SupportedMediaType; language?: string; entityTypes?: string[] },
    uid: ReturnType<typeof userId>,
  ) {
    const uri = deriveStorageUri(`test-${++fileCounter}`, opts.format);
    const stored = await kb.content.store(opts.content, uri);
    return ResourceOperations.createResource(
      { name: opts.name, storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format: opts.format, language: opts.language, entityTypes: opts.entityTypes },
      uid,
      eventBus,
    );
  }

  beforeAll(async () => {
    const { project, teardown: td } = await createTestProject('annotation-ops');
    teardown = td;
    suiteProject = project;

    // Initialize EventBus and stores
    eventBus = new EventBus();
    testEventStore = createEventStore(project, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    const { WorkingTreeStore } = await import('@semiont/content');
    const repStore = new WorkingTreeStore(project, mockLogger);
    kb = { eventStore: testEventStore, views: testEventStore.viewStorage, content: repStore, graph: graphDb, projectionsDir: project.projectionsDir, weaveProgress: {} as any };

    stower = new Stower(kb, eventBus, project, mockLogger);
    await stower.initialize();

    // Create a test resource for annotations
    const resId = await create(
      {
        name: 'Annotation Test Resource',
        content: Buffer.from('This is test content for annotations. It has multiple sentences. We will annotate various parts.', 'utf-8'),
        format: 'text/plain',
      },
      userId('user-1'),
    );

    testResourceId = resId;
  });

  afterAll(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('createAnnotation', () => {
    it('creates a resource-level edge: source-only target + SpecificResource body (P2)', async () => {
      const result = await createAnnotationAndAwait(
        {
          motivation: 'linking',
          target: { source: testResourceId }, // whole-resource target, no selector
          body: { type: 'SpecificResource', source: testResourceId, purpose: 'linking' },
        },
        userId('user-1'),
        eventBus,
      );

      expect(result.annotation.motivation).toBe('linking');
      // target persisted verbatim — selector-less (RESOURCE-LEVEL-ANCHOR P2)
      expect(result.annotation.target).toEqual({ source: testResourceId });
      expect(result.annotation.id.length).toBeGreaterThan(0);
    });

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
      const creator = { '@type': 'Person' as const, '@id': 'did:web:test.local:users:test-user', name: 'Test User' };
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

  describe('updateEntityTypes (Stower)', () => {
    it('diffs the sets — appends entity-tag-added AND entity-tag-removed — then acks with a correlated -ok', async () => {
      // The SDK's `mark.updateEntityTypes` is a confirmed busRequest write: it
      // awaits this correlation-keyed reply. Before the reply was wired, the
      // handler appended the mark:entity-tag-* events but never acked, so the
      // request would hang to timeout (.plans/bugs/BRIDGE-GAPS.md shape).
      // Passing a non-empty `current` that differs from `updated` exercises both
      // diff branches: 'Person' is added, 'Legacy' is removed.
      // The vocabulary gate requires ADDS to be registered (removals are never
      // gated — 'Legacy' needs no registration), so register 'Person' first.
      const systemDir = join(suiteProject.stateDir, 'projections', '__system__');
      await fs.mkdir(systemDir, { recursive: true });
      await fs.writeFile(join(systemDir, 'entitytypes.json'), JSON.stringify({ entityTypes: ['Person'] }));

      const correlationId = 'uet-cid-1';
      const ok$ = firstValueFrom(
        eventBus.get('mark:update-entity-types-ok').pipe(
          filter((e) => e.correlationId === correlationId),
          take(1),
        ),
      );

      eventBus.get('mark:update-entity-types').next({
        correlationId,
        _userId: 'user-1',
        resourceId: testResourceId,
        currentEntityTypes: ['Legacy'],
        updatedEntityTypes: ['Person'],
      });

      await ok$;

      const events = await testEventStore.log.getEvents(resourceId(testResourceId));
      const tag = (type: string, entityType: string) =>
        events.some(
          (e) => e.type === type && (e.payload as { entityType?: string }).entityType === entityType,
        );
      expect(tag('mark:entity-tag-added', 'Person')).toBe(true);
      expect(tag('mark:entity-tag-removed', 'Legacy')).toBe(true);
    });

    it('routes an append failure to a correlated mark:update-entity-types-failed (not silently dropped)', async () => {
      // The confirmed-write guarantee: if the backend write throws, the failure
      // must come back on the correlated reply channel so the SDK's busRequest
      // rejects — the "failure has nowhere to go" bug BRIDGE-GAPS.md removed.
      // Isolated Stower over a KB whose eventStore.appendEvent rejects, so the
      // catch branch runs without disturbing the shared real-KB harness.
      const failBus = new EventBus();
      const failingKb = {
        eventStore: { appendEvent: vi.fn().mockRejectedValue(new Error('disk full')) },
      } as unknown as KnowledgeBase;
      const failStower = new Stower(failingKb, failBus, suiteProject, mockLogger);
      await failStower.initialize();

      const correlationId = 'uet-cid-fail';
      const failed$ = firstValueFrom(
        failBus.get('mark:update-entity-types-failed').pipe(
          filter((e) => e.correlationId === correlationId),
          take(1),
        ),
      );

      // A REMOVAL, not an add: removals are never vocabulary-gated (the gate
      // would otherwise reject the tag before appendEvent runs), so this still
      // exercises the append-failure catch branch — the test's actual subject.
      failBus.get('mark:update-entity-types').next({
        correlationId,
        _userId: 'user-1',
        resourceId: testResourceId,
        currentEntityTypes: ['Person'],
        updatedEntityTypes: [],
      });

      const failure = await failed$;
      expect(failure.message).toContain('disk full');

      await failStower.stop();
      failBus.destroy();
    });
  });
});
