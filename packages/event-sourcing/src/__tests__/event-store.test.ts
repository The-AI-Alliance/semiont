/**
 * Event Store Tests - Fast, Essential Coverage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventStore } from '../event-store';
import { EventQuery } from '../query/event-query';
import { FilesystemViewStorage } from '../storage/view-storage';
import { SemiontProject } from '@semiont/core/node';
import { CREATION_METHODS, resourceId, userId, EventBus } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

describe('Event Store', () => {
  let testDir: string;
  let project: SemiontProject;
  let eventStore: EventStore;
  let query: EventQuery;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir);

    const viewStorage = new FilesystemViewStorage(project);

    eventStore = new EventStore(
      project,
      testDir,
      viewStorage,
      new EventBus(),
    );

    query = new EventQuery(eventStore.log.storage);
  });

  afterAll(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should emit and retrieve events', async () => {
    const docId = resourceId('doc-test1');

    const event1 = await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: {
        name: 'Test',
        format: 'text/plain',
        contentChecksum: 'hash1',
        creationMethod: CREATION_METHODS.API,
      },
    });

    expect(event1.metadata.sequenceNumber).toBe(1);

    const events = await query.getResourceEvents(docId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('yield:created');
  });

  it('should rebuild projection from events', async () => {
    const docId = resourceId('doc-test3');

    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: { name: 'Doc', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
    });

    await eventStore.appendEvent({
      type: 'mark:entity-tag-added',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: { entityType: 'note' },
    });

    const events = await query.getResourceEvents(docId);
    const stored = await eventStore.views.materializer.materialize(events, docId);

    expect(stored).toBeDefined();
    expect(stored!.resource.name).toBe('Doc');
    // Note: content is NOT in projections - must be loaded from filesystem separately
    expect(stored!.resource.entityTypes).toContain('note');
    expect(stored!.annotations.version).toBe(2);
  });

  /**
   * Threads correlationId through to event metadata. Load-bearing for the
   * unified-stream architecture: the events-stream route reads metadata.correlationId
   * to let subscribers match command-result events back to the POST that
   * initiated them. Phase 0b.
   */
  it('appendEvent threads correlationId through to event metadata', async () => {
    const docId = resourceId('doc-correlation-test');
    const cid = 'corr-abc-123';

    const stored = await eventStore.appendEvent(
      {
        type: 'yield:created',
        resourceId: docId,
        userId: userId('user1'),
        version: 1,
        payload: {
          name: 'Doc',
          format: 'text/plain',
          contentChecksum: 'sha:abc',
          creationMethod: CREATION_METHODS.API,
        },
      },
      { correlationId: cid },
    );

    expect(stored.metadata.correlationId).toBe(cid);

    // Re-reading from disk should preserve the correlationId
    const events = await query.getResourceEvents(docId);
    const reread = events.find((e) => e.id === stored.id);
    expect(reread?.metadata.correlationId).toBe(cid);
  });

  it('appendEvent without correlationId leaves the field absent', async () => {
    const docId = resourceId('doc-no-correlation');

    const stored = await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: {
        name: 'Doc',
        format: 'text/plain',
        contentChecksum: 'sha:abc',
        creationMethod: CREATION_METHODS.API,
      },
    });

    expect(stored.metadata.correlationId).toBeUndefined();
  });

  /**
   * Load-bearing for bind-annotation-stream: the route subscribes to
   * mark:body-updated on the scoped EventBus and reads the updated annotation
   * from the materialized view in its handler. That sequence is correct only
   * because appendEvent awaits materializeResource BEFORE publishing on the
   * scoped bus. If a future refactor moves materialization to a fire-and-forget
   * background task, this test fails BEFORE the bind-stream behavior silently
   * breaks.
   */
  it('appendEvent awaits materialization before resolving (load-bearing for bind-stream)', async () => {
    const docId = resourceId('doc-ordering-test');
    const annId = 'ann-ordering-test';

    // Create the resource
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: {
        name: 'Ordering Test Doc',
        format: 'text/plain',
        contentChecksum: 'sha:ord',
        creationMethod: CREATION_METHODS.API,
      },
    });

    // Create a stub reference annotation
    await eventStore.appendEvent({
      type: 'mark:added',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
          type: 'Annotation' as const,
          id: annId,
          motivation: 'linking' as const,
          target: {
            source: docId,
            selector: [
              { type: 'TextPositionSelector', start: 0, end: 4 },
              { type: 'TextQuoteSelector', exact: 'Test' },
            ],
          },
          body: [],
          modified: new Date().toISOString(),
        },
      },
    });

    // Bind: apply mark:body-updated to add a SpecificResource
    await eventStore.appendEvent({
      type: 'mark:body-updated',
      resourceId: docId,
      userId: userId('user1'),
      version: 1,
      payload: {
        annotationId: annId,
        operations: [
          {
            op: 'add',
            item: {
              type: 'SpecificResource',
              source: 'res-target-ord',
              purpose: 'linking',
            },
          },
        ] as any,
      },
    });

    // CRITICAL: by the time appendEvent resolved, the view file must already
    // contain the updated annotation. No setTimeout, no polling, no microtask
    // wait — synchronously after the await.
    const view = await eventStore.viewStorage.get(docId);
    expect(view).not.toBeNull();
    const ann = view!.annotations.annotations.find((a) => a.id === annId);
    expect(ann).toBeDefined();
    expect(ann!.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'SpecificResource',
          source: 'res-target-ord',
        }),
      ]),
    );
  });
});
