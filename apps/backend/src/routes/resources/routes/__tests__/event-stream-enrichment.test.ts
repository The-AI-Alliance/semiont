/**
 * Tests for event-stream enrichment helpers.
 *
 * Pure view-read logic against an in-memory KB plus the typed
 * eventAnnotationId discriminator. The Hono route wiring is covered by
 * manual e2e — these tests cover the logic that could be wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { SemiontProject } from '@semiont/core/node';
import { EventBus, resourceId, userId, CREATION_METHODS, annotationId as makeAnnotationId, type Logger, type StoredEvent } from '@semiont/core';
import { createEventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import type { KnowledgeBase } from '@semiont/make-meaning';

import { readAnnotationFromView, eventAnnotationId } from '../event-stream-enrichment';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

describe('readAnnotationFromView', () => {
  let testDir: string;
  let project: SemiontProject;
  let kb: KnowledgeBase;
  let eventStore: ReturnType<typeof createEventStore>;

  const RID = resourceId('doc-bind-helper-test');
  const ANNOTATION_ID = 'ann-bind-helper-1';

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `semiont-bind-helper-test-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });

    project = new SemiontProject(testDir);
    eventStore = createEventStore(project, new EventBus(), mockLogger);

    const viewStorage = new FilesystemViewStorage(project);
    kb = {
      eventStore,
      views: viewStorage,
      content: {} as any,
      graph: {} as any,
      graphConsumer: {} as any,
      projectionsDir: project.projectionsDir,
    };

    // Seed: create the resource
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: RID,
      userId: userId('test-user'),
      version: 1,
      payload: {
        name: 'Test Doc',
        format: 'text/plain',
        contentChecksum: 'sha:abc',
        creationMethod: CREATION_METHODS.API,
      },
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('returns the annotation with the post-bind body after appendEvent', async () => {
    // Create a stub reference annotation (empty body)
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: RID,
      userId: userId('test-user'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: ANNOTATION_ID,
          motivation: 'linking',
          created: new Date().toISOString(),
          target: {
            source: RID as string,
            selector: [
              { type: 'TextPositionSelector', start: 0, end: 5 },
              { type: 'TextQuoteSelector', exact: 'hello' },
            ],
          },
          body: [],
        } as any,
      },
    });

    // Bind: add a SpecificResource via mark:body-updated
    await eventStore.appendEvent({
      type: 'mark:body-updated',
      resourceId: RID,
      userId: userId('test-user'),
      version: 1,
      payload: {
        annotationId: ANNOTATION_ID,
        operations: [
          {
            op: 'add',
            item: {
              type: 'SpecificResource',
              source: 'res-target',
              purpose: 'linking',
            },
          },
        ] as any,
      },
    });

    // Read the post-bind state
    const result = await readAnnotationFromView(kb, RID, ANNOTATION_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(ANNOTATION_ID);
    expect(result?.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'SpecificResource',
          source: 'res-target',
        }),
      ]),
    );
  });

  it('returns null when the annotation does not exist in the view', async () => {
    const result = await readAnnotationFromView(kb, RID, 'nonexistent-annotation-id');
    expect(result).toBeNull();
  });

  it('preserves enriched _resolvedDocumentName from getAllAnnotations', async () => {
    // Create a target resource that the bind will link to
    const targetId = resourceId('res-target-enriched');
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: targetId,
      userId: userId('test-user'),
      version: 1,
      payload: {
        name: 'Target Document Name',
        format: 'text/plain',
        contentChecksum: 'sha:def',
        creationMethod: CREATION_METHODS.API,
      },
    });

    // Create the stub reference
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: RID,
      userId: userId('test-user'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: ANNOTATION_ID,
          motivation: 'linking',
          created: new Date().toISOString(),
          target: {
            source: RID as string,
            selector: [
              { type: 'TextPositionSelector', start: 0, end: 5 },
              { type: 'TextQuoteSelector', exact: 'hello' },
            ],
          },
          body: [],
        } as any,
      },
    });

    // Bind to the target
    await eventStore.appendEvent({
      type: 'mark:body-updated',
      resourceId: RID,
      userId: userId('test-user'),
      version: 1,
      payload: {
        annotationId: ANNOTATION_ID,
        operations: [
          {
            op: 'add',
            item: {
              type: 'SpecificResource',
              source: targetId as string,
              purpose: 'linking',
            },
          },
        ] as any,
      },
    });

    const result = await readAnnotationFromView(kb, RID, ANNOTATION_ID);
    expect(result).not.toBeNull();

    // The enriched field should be present (added by AnnotationContext.enrichResolvedReferences)
    expect((result as any)._resolvedDocumentName).toBe('Target Document Name');
  });
});

describe('eventAnnotationId', () => {
  /** Helper: build a minimal StoredEvent with the bare fields the discriminator needs. */
  function makeStored<T extends StoredEvent['type']>(type: T, payload: any): StoredEvent {
    return {
      id: 'evt-id',
      type,
      timestamp: new Date().toISOString(),
      userId: userId('user-1'),
      version: 1,
      payload,
      metadata: { sequenceNumber: 1, streamPosition: 0 },
    } as unknown as StoredEvent;
  }

  it('returns annotation.id for mark:added', () => {
    const event = makeStored('mark:added', {
      annotation: { id: 'ann-1', motivation: 'linking', target: { source: 'res-1' }, body: [] },
    });
    expect(eventAnnotationId(event)).toBe('ann-1');
  });

  it('returns annotationId for mark:body-updated', () => {
    const event = makeStored('mark:body-updated', {
      annotationId: makeAnnotationId('ann-2'),
      operations: [],
    });
    expect(eventAnnotationId(event)).toBe('ann-2');
  });

  it('returns annotationId for mark:removed', () => {
    const event = makeStored('mark:removed', {
      annotationId: makeAnnotationId('ann-3'),
    });
    expect(eventAnnotationId(event)).toBe('ann-3');
  });

  it('returns null for events that do not mutate annotations', () => {
    const event = makeStored('yield:created', {
      name: 'Doc',
      format: 'text/plain',
      contentChecksum: 'sha:abc',
      creationMethod: 'api',
    });
    expect(eventAnnotationId(event)).toBeNull();
  });

  it('returns null for job events', () => {
    const event = makeStored('job:completed', {
      jobId: 'job-1',
      jobType: 'reference-annotation',
    });
    expect(eventAnnotationId(event)).toBeNull();
  });

  it('returns null for entity tag events (which mutate the resource, not an annotation)', () => {
    const event = makeStored('mark:entity-tag-added', {
      entityType: 'Person',
    });
    expect(eventAnnotationId(event)).toBeNull();
  });
});
