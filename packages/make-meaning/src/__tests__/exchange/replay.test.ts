/**
 * Event Replay Tests
 *
 * Tests the event replay engine that translates domain events to command
 * events via EventBus with backpressure. Covers:
 * - Hash chain validation
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
import { EventBus, type ResourceId, type UserId, type AnnotationId, type ResourceEvent } from '@semiont/core';
import type { components } from '@semiont/core';
import { replayEventStream, type ContentBlobResolver } from '../../exchange/replay';

const TEST_USER = 'did:web:localhost:users:test' as UserId;
const TEST_RESOURCE = 'test-resource-id' as ResourceId;
const TEST_ANNOTATION = 'test-annotation-id' as AnnotationId;

/** Minimal ResourceDescriptor stub for yield:created test emissions (value is never inspected). */
const STUB_RESOURCE: components['schemas']['ResourceDescriptor'] = {
  '@context': 'https://schema.org',
  '@id': 'http://test/resources/stub',
  name: 'stub',
  representations: [],
};

/** Minimal AnnotationBodyUpdatedEvent stub for mark:body-updated test emissions. */
function stubBodyUpdatedEvent(): Extract<ResourceEvent, { type: 'annotation.body.updated' }> {
  return {
    id: 'stub',
    timestamp: '2026-03-12T00:00:00Z',
    userId: TEST_USER,
    version: 1,
    type: 'annotation.body.updated',
    resourceId: TEST_RESOURCE,
    payload: { annotationId: TEST_ANNOTATION, operations: [] },
  };
}

function makeStoredEvent(event: Record<string, unknown>, opts: { checksum?: string; prevEventHash?: string } = {}): string {
  return JSON.stringify({
    event,
    metadata: {
      sequenceNumber: 1,
      streamPosition: 0,
      timestamp: '2026-03-12T00:00:00Z',
      checksum: opts.checksum || 'abc123',
      prevEventHash: opts.prevEventHash || null,
    },
  });
}

function entityTypeEvent(entityType: string, opts: { checksum?: string; prevEventHash?: string } = {}): string {
  return makeStoredEvent({
    type: 'entitytype.added',
    payload: { entityType },
    userId: TEST_USER,
  }, opts);
}

function resourceCreatedEvent(name: string, contentChecksum: string, opts: { checksum?: string; prevEventHash?: string } = {}): string {
  return makeStoredEvent({
    type: 'resource.created',
    resourceId: TEST_RESOURCE,
    userId: TEST_USER,
    payload: {
      name,
      contentChecksum,
      format: 'text/markdown',
      language: 'en',
      entityTypes: [],
      creationMethod: 'api',
    },
  }, opts);
}

function annotationAddedEvent(annotationId: string, opts: { checksum?: string; prevEventHash?: string } = {}): string {
  return makeStoredEvent({
    type: 'annotation.added',
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
  }, opts);
}

/**
 * Defer a callback to the next microtask so that firstValueFrom(result$)
 * subscribes before the result event fires through the RxJS Subject.
 */
function defer(fn: () => void): void {
  queueMicrotask(fn);
}

describe('replay', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventBus.destroy();
  });

  describe('replayEventStream', () => {
    it('replays an entitytype.added event', async () => {
      eventBus.get('mark:add-entity-type').subscribe((msg) => {
        expect(msg.tag).toBe('Person');
        defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'Person' }));
      });

      const jsonl = entityTypeEvent('Person');
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);

      expect(result.stats.eventsReplayed).toBe(1);
      expect(result.stats.entityTypesAdded).toBe(1);
      expect(result.hashChainValid).toBe(true);
    });

    it('replays a resource.created event with content blob', async () => {
      const contentBlob = Buffer.from('# Hello World', 'utf8');
      const resolver: ContentBlobResolver = (checksum) =>
        checksum === 'sha256-abc' ? contentBlob : undefined;

      eventBus.get('yield:create').subscribe((msg) => {
        expect(msg.name).toBe('Test Resource');
        expect(msg.content).toBe(contentBlob);
        expect(msg.format).toBe('text/markdown');
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      const jsonl = resourceCreatedEvent('Test Resource', 'sha256-abc');
      const result = await replayEventStream(jsonl, eventBus, resolver);

      expect(result.stats.eventsReplayed).toBe(1);
      expect(result.stats.resourcesCreated).toBe(1);
    });

    it('throws when content blob is missing for resource.created', async () => {
      const resolver: ContentBlobResolver = () => undefined;

      const jsonl = resourceCreatedEvent('Test Resource', 'missing-checksum');

      await expect(
        replayEventStream(jsonl, eventBus, resolver)
      ).rejects.toThrow(/Missing content blob/);
    });

    it('replays an annotation.added event', async () => {
      eventBus.get('mark:create').subscribe(() => {
        defer(() => eventBus.get('mark:created').next({ annotationId: TEST_ANNOTATION }));
      });

      const jsonl = annotationAddedEvent('ann-1');
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);

      expect(result.stats.eventsReplayed).toBe(1);
      expect(result.stats.annotationsCreated).toBe(1);
    });

    it('replays an annotation.body.updated event', async () => {
      eventBus.get('mark:update-body').subscribe((msg) => {
        expect(msg.annotationId).toBe(TEST_ANNOTATION);
        defer(() => eventBus.get('mark:body-updated').next(stubBodyUpdatedEvent()));
      });

      const jsonl = makeStoredEvent({
        type: 'annotation.body.updated',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: {
          annotationId: TEST_ANNOTATION,
          operations: [{ op: 'replace', path: '/value', value: 'updated' }],
        },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(1);
    });

    it('replays an annotation.removed event', async () => {
      eventBus.get('mark:delete').subscribe(() => {
        defer(() => eventBus.get('mark:deleted').next({ annotationId: TEST_ANNOTATION }));
      });

      const jsonl = makeStoredEvent({
        type: 'annotation.removed',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: { annotationId: TEST_ANNOTATION },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(1);
    });

    it('replays resource.archived as fire-and-forget', async () => {
      const archiveSpy = vi.fn();
      eventBus.get('mark:archive').subscribe(archiveSpy);

      const jsonl = makeStoredEvent({
        type: 'resource.archived',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: {},
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(1);
      expect(archiveSpy).toHaveBeenCalledOnce();
    });

    it('replays resource.unarchived as fire-and-forget', async () => {
      const unarchiveSpy = vi.fn();
      eventBus.get('mark:unarchive').subscribe(unarchiveSpy);

      const jsonl = makeStoredEvent({
        type: 'resource.unarchived',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: {},
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(1);
      expect(unarchiveSpy).toHaveBeenCalledOnce();
    });

    it('replays entitytag.added through mark:update-entity-types', async () => {
      const updateSpy = vi.fn();
      eventBus.get('mark:update-entity-types').subscribe(updateSpy);

      const jsonl = makeStoredEvent({
        type: 'entitytag.added',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: { entityType: 'Person' },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedEntityTypes: ['Person'],
          currentEntityTypes: [],
        })
      );
    });

    it('replays entitytag.removed through mark:update-entity-types', async () => {
      const updateSpy = vi.fn();
      eventBus.get('mark:update-entity-types').subscribe(updateSpy);

      const jsonl = makeStoredEvent({
        type: 'entitytag.removed',
        resourceId: TEST_RESOURCE,
        userId: TEST_USER,
        payload: { entityType: 'Location' },
      });
      const resolver: ContentBlobResolver = () => undefined;

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(1);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          currentEntityTypes: ['Location'],
          updatedEntityTypes: [],
        })
      );
    });

    it('skips job events without error', async () => {
      const jobTypes = ['job.started', 'job.progress', 'job.completed', 'job.failed'];
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

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(4);
      expect(result.stats.resourcesCreated).toBe(0);
      expect(result.stats.annotationsCreated).toBe(0);
    });

    it('skips representation events without error', async () => {
      const repTypes = ['representation.added', 'representation.removed'];
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

      const result = await replayEventStream(jsonl, eventBus, resolver);
      expect(result.stats.eventsReplayed).toBe(2);
    });

    it('replays multiple events and accumulates stats', async () => {
      eventBus.get('mark:add-entity-type').subscribe(() => {
        defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'Person' }));
      });

      const contentBlob = Buffer.from('test content');
      const resolver: ContentBlobResolver = (checksum) =>
        checksum === 'sha-1' ? contentBlob : undefined;

      eventBus.get('yield:create').subscribe(() => {
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      eventBus.get('mark:create').subscribe(() => {
        defer(() => eventBus.get('mark:created').next({ annotationId: TEST_ANNOTATION }));
      });

      const lines = [
        entityTypeEvent('Person', { checksum: 'c1' }),
        resourceCreatedEvent('Doc', 'sha-1', { checksum: 'c2', prevEventHash: 'c1' }),
        annotationAddedEvent('ann-1', { checksum: 'c3', prevEventHash: 'c2' }),
      ];

      const result = await replayEventStream(lines.join('\n'), eventBus, resolver);

      expect(result.stats.eventsReplayed).toBe(3);
      expect(result.stats.entityTypesAdded).toBe(1);
      expect(result.stats.resourcesCreated).toBe(1);
      expect(result.stats.annotationsCreated).toBe(1);
      expect(result.hashChainValid).toBe(true);
    });
  });

  describe('hash chain validation', () => {
    it('detects a valid hash chain', async () => {
      eventBus.get('mark:add-entity-type').subscribe(() => {
        defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'done' }));
      });

      const lines = [
        entityTypeEvent('A', { checksum: 'hash-1' }),
        entityTypeEvent('B', { checksum: 'hash-2', prevEventHash: 'hash-1' }),
      ];

      const resolver: ContentBlobResolver = () => undefined;
      const result = await replayEventStream(lines.join('\n'), eventBus, resolver);

      expect(result.hashChainValid).toBe(true);
    });

    it('detects a broken hash chain', async () => {
      eventBus.get('mark:add-entity-type').subscribe(() => {
        defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'done' }));
      });

      const lines = [
        entityTypeEvent('A', { checksum: 'hash-1' }),
        entityTypeEvent('B', { checksum: 'hash-2', prevEventHash: 'WRONG-HASH' }),
      ];

      const resolver: ContentBlobResolver = () => undefined;
      const result = await replayEventStream(lines.join('\n'), eventBus, resolver);

      expect(result.hashChainValid).toBe(false);
    });

    it('treats missing prevEventHash as valid (first event in stream)', async () => {
      eventBus.get('mark:add-entity-type').subscribe(() => {
        defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'done' }));
      });

      const lines = [
        entityTypeEvent('A', { checksum: 'hash-1' }),
      ];

      const resolver: ContentBlobResolver = () => undefined;
      const result = await replayEventStream(lines.join('\n'), eventBus, resolver);

      expect(result.hashChainValid).toBe(true);
    });
  });
});
