/**
 * Event Replay Tests
 *
 * Tests the event replay engine that translates domain events to command
 * events via EventBus with backpressure. Covers:
 * - Event type dispatch (resource.created, annotation.added, etc.)
 * - Skipped event types (job.*, representation.*)
 * - Content blob resolution
 * - Stats accumulation
 *
 * Note: RxJS Subjects are synchronous — test handlers must defer result
 * emission via queueMicrotask so that firstValueFrom(result$) subscribes
 * before the result event fires.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type ResourceId, type UserId, type AnnotationId, type PersistedEvent } from '@semiont/core';
import type { WorkingTreeStore } from '@semiont/content';
import type { EventStore } from '@semiont/event-sourcing';
import { replayEventStream, type ContentBlobResolver } from '../../exchange/replay';

const TEST_USER = 'did:web:localhost:users:test' as UserId;
const TEST_RESOURCE = 'test-resource-id' as ResourceId;
const TEST_ANNOTATION = 'test-annotation-id' as AnnotationId;

/** Minimal ResourceDescriptor stub for yield:created test emissions (value is never inspected). */
/** Minimal AnnotationBodyUpdatedEvent stub for mark:body-updated test emissions. */
function stubBodyUpdatedEvent(): Extract<PersistedEvent, { type: 'mark:body-updated' }> {
  return {
    id: 'stub',
    timestamp: '2026-03-12T00:00:00Z',
    userId: TEST_USER,
    version: 1,
    type: 'mark:body-updated',
    resourceId: TEST_RESOURCE,
    payload: { annotationId: TEST_ANNOTATION, operations: [] },
  };
}

function makeStoredEvent(event: Record<string, unknown>): string {
  return JSON.stringify({
    ...event,
    metadata: {
      sequenceNumber: 1,
    },
  });
}

function entityTypeEvent(entityType: string): string {
  return makeStoredEvent({
    type: 'frame:entity-type-added',
    payload: { entityType },
    userId: TEST_USER,
  });
}

function resourceCreatedEvent(name: string, contentChecksum: string): string {
  return makeStoredEvent({
    type: 'yield:created',
    resourceId: TEST_RESOURCE,
    userId: TEST_USER,
    payload: {
      name,
      contentChecksum,
      format: 'text/markdown',
      language: 'en',
      entityTypes: [],
    },
  });
}

function annotationAddedEvent(annotationId: string): string {
  return makeStoredEvent({
    type: 'mark:added',
    resourceId: TEST_RESOURCE,
    userId: TEST_USER,
    payload: {
      annotation: {
        id: annotationId,
        type: 'Annotation',
        motivation: 'commenting',
        body: { type: 'TextualBody', value: 'test' },
        target: { source: 'http://example.com' },
      },
    },
  });
}

/**
 * Defer a callback to the next microtask so that firstValueFrom(result$)
 * subscribes before the result event fires through the RxJS Subject.
 */
function defer(fn: () => void): void {
  queueMicrotask(fn);
}

const mockContentStore = {
  store: vi.fn().mockResolvedValue({ storageUri: 'file://test.md', checksum: 'abc123', byteSize: 100, created: new Date().toISOString() }),
  register: vi.fn().mockResolvedValue({ storageUri: 'file://test.md', checksum: 'abc123', byteSize: 100, created: new Date().toISOString() }),
} as unknown as WorkingTreeStore;

// Replay appends historical events as facts (never re-issues commands) —
// the fake captures those appends for assertion.
const mockAppendEvent = vi.fn().mockResolvedValue(undefined);
const mockEventStore = { appendEvent: mockAppendEvent } as unknown as EventStore;

describe('replay', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    mockAppendEvent.mockClear();
  });

  afterEach(() => {
    eventBus.destroy();
  });

  describe('replayEventStream', () => {
    it('replays an entitytype.added event', async () => {
      eventBus.get('frame:add-entity-type').subscribe((msg) => {
        expect(msg.tag).toBe('Person');
        defer(() => eventBus.get('frame:entity-type-add-ok').next({ correlationId: msg.correlationId } as any));
      });

      const jsonl = entityTypeEvent('Person');
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);

      expect(result.stats.eventsReplayed).toBe(1);
      expect(result.stats.entityTypesAdded).toBe(1);
    });

    it('replays a resource.created event with content blob', async () => {
      const contentBlob = Buffer.from('# Hello World', 'utf8');
      const resolver: ContentBlobResolver = (checksum) =>
        checksum === 'sha256-abc' ? contentBlob : undefined;

      eventBus.get('yield:create').subscribe((msg) => {
        expect(msg.name).toBe('Test Resource');
        expect(msg.storageUri).toBeDefined();
        expect(msg.contentChecksum).toBeDefined();
        expect(msg.format).toBe('text/markdown');
        defer(() => eventBus.get('yield:create-ok').next({
          correlationId: msg.correlationId,
          response: { resourceId: TEST_RESOURCE },
        }));
      });

      const jsonl = resourceCreatedEvent('Test Resource', 'sha256-abc');
      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);

      expect(result.stats.eventsReplayed).toBe(1);
      expect(result.stats.resourcesCreated).toBe(1);
    });

    it('throws when content blob is missing for resource.created', async () => {
      const resolver: ContentBlobResolver = () => undefined;

      const jsonl = resourceCreatedEvent('Test Resource', 'missing-checksum');

      await expect(
        replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore)
      ).rejects.toThrow(/Missing content blob/);
    });

    it('replays an annotation.added event', async () => {
      eventBus.get('mark:create').subscribe(() => {
        defer(() => eventBus.get('mark:create-ok').next({ response: { annotationId: TEST_ANNOTATION } }));
      });

      const jsonl = annotationAddedEvent('ann-1');
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);

      expect(result.stats.eventsReplayed).toBe(1);
      expect(result.stats.annotationsCreated).toBe(1);
    });

    it('replays an annotation.body.updated event', async () => {
      eventBus.get('mark:update-body').subscribe((msg) => {
        expect(msg.annotationId).toBe(TEST_ANNOTATION);
        defer(() => eventBus.get('mark:body-updated').next(stubBodyUpdatedEvent() as any));
      });

      const jsonl = makeStoredEvent({
        type: 'mark:body-updated',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: {
          annotationId: TEST_ANNOTATION,
          operations: [{ op: 'replace', path: '/value', value: 'updated' }],
        },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(1);
    });

    it('replays an annotation.removed event', async () => {
      eventBus.get('mark:delete').subscribe(() => {
        defer(() => eventBus.get('mark:delete-ok').next({ response: { annotationId: TEST_ANNOTATION } }));
      });

      const jsonl = makeStoredEvent({
        type: 'mark:removed',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: { annotationId: TEST_ANNOTATION },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(1);
    });

    it('replays resource.archived as fire-and-forget', async () => {
      const archiveSpy = vi.fn();
      eventBus.get('mark:archive').subscribe(archiveSpy);

      const jsonl = makeStoredEvent({
        type: 'mark:archived',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: {},
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(1);
      expect(archiveSpy).toHaveBeenCalledOnce();
    });

    it('replays resource.unarchived as fire-and-forget', async () => {
      const unarchiveSpy = vi.fn();
      eventBus.get('mark:unarchive').subscribe(unarchiveSpy);

      const jsonl = makeStoredEvent({
        type: 'mark:unarchived',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: {},
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(1);
      expect(unarchiveSpy).toHaveBeenCalledOnce();
    });

    // Replay semantics (ratified 2026-07-09): events are facts, commands are
    // requests — replay appends the historical event verbatim and NEVER
    // re-issues mark:update-entity-types. This excludes imports from the
    // vocabulary gate by construction (pre-gate warts restore as the facts
    // they are) and stops replay minting duplicate -added events from a
    // fabricated empty diff base.
    it('replays entitytag.added by appending the historical event verbatim', async () => {
      const updateSpy = vi.fn();
      eventBus.get('mark:update-entity-types').subscribe(updateSpy);

      const jsonl = makeStoredEvent({
        type: 'mark:entity-tag-added',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: { entityType: 'Person' },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(1);
      // the fact is copied — original user preserved, payload verbatim
      expect(mockAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mark:entity-tag-added',
          resourceId: TEST_RESOURCE,
          userId: TEST_USER,
          payload: { entityType: 'Person' },
        })
      );
      // no command re-issued: replay must not re-adjudicate history
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('replays entitytag.removed by appending the historical event verbatim', async () => {
      const updateSpy = vi.fn();
      eventBus.get('mark:update-entity-types').subscribe(updateSpy);

      const jsonl = makeStoredEvent({
        type: 'mark:entity-tag-removed',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: { entityType: 'Location' },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(1);
      expect(mockAppendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mark:entity-tag-removed',
          resourceId: TEST_RESOURCE,
          userId: TEST_USER,
          payload: { entityType: 'Location' },
        })
      );
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('skips job events without error', async () => {
      const jobTypes = ['job:started', 'job:progress', 'job:completed', 'job:failed'];
      const lines = jobTypes.map((type) =>
        makeStoredEvent({
          type,
          resourceId: TEST_RESOURCE,
          userId: TEST_USER,
          payload: {},
        })
      );

      const jsonl = lines.join('\n');
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(4);
      expect(result.stats.resourcesCreated).toBe(0);
      expect(result.stats.annotationsCreated).toBe(0);
    });

    it('skips representation events without error', async () => {
      const repTypes = ['yield:representation-added', 'yield:representation-removed'];
      const lines = repTypes.map((type) =>
        makeStoredEvent({
          type,
          resourceId: TEST_RESOURCE,
          userId: TEST_USER,
          payload: {},
        })
      );

      const jsonl = lines.join('\n');
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, mockEventStore, resolver, mockContentStore);
      expect(result.stats.eventsReplayed).toBe(2);
    });

    it('replays multiple events and accumulates stats', async () => {
      eventBus.get('frame:add-entity-type').subscribe((msg) => {
        defer(() => eventBus.get('frame:entity-type-add-ok').next({ correlationId: msg.correlationId } as any));
      });

      const contentBlob = Buffer.from('test content');
      const resolver: ContentBlobResolver = (checksum) =>
        checksum === 'sha-1' ? contentBlob : undefined;

      eventBus.get('yield:create').subscribe((msg) => {
        defer(() => eventBus.get('yield:create-ok').next({
          correlationId: msg.correlationId,
          response: { resourceId: TEST_RESOURCE },
        }));
      });

      eventBus.get('mark:create').subscribe(() => {
        defer(() => eventBus.get('mark:create-ok').next({ response: { annotationId: TEST_ANNOTATION } }));
      });

      const lines = [
        entityTypeEvent('Person'),
        resourceCreatedEvent('Doc', 'sha-1'),
        annotationAddedEvent('ann-1'),
      ];

      const result = await replayEventStream(lines.join('\n'), eventBus, mockEventStore, resolver, mockContentStore);

      expect(result.stats.eventsReplayed).toBe(3);
      expect(result.stats.entityTypesAdded).toBe(1);
      expect(result.stats.resourcesCreated).toBe(1);
      expect(result.stats.annotationsCreated).toBe(1);
    });
  });
});
