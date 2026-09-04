/**
 * ViewMaterializer Tests - View materialization from events
 *
 * Tests event-to-view transformation, incremental updates, and system views
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ViewMaterializer } from '@semiont/event-sourcing';
import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, userId, annotationId } from '@semiont/core';
import type { StoredEvent, PersistedEvent } from '@semiont/core';

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getPrimaryRepresentation } from '@semiont/core';
describe('ViewMaterializer', () => {
  let testDir: string;
  let projector: ViewMaterializer;
  let project: SemiontProject;
  let viewStorage: FilesystemViewStorage;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-projector-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });

    project = new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` });
    viewStorage = new FilesystemViewStorage(project);
    projector = new ViewMaterializer(viewStorage, {
      basePath: testDir,
    });
  });

  afterEach(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create StoredEvent
  function createStoredEvent(event: Omit<PersistedEvent, 'id' | 'timestamp' | 'version' | 'userId'> & { userId?: string }, sequenceNumber: number): StoredEvent {
    const fullEvent: PersistedEvent = {
      id: `event-${sequenceNumber}`,
      userId: event.userId || 'user1',
      timestamp: new Date().toISOString(),
      version: 1,
      ...event,
    } as PersistedEvent;

    return {
      ...fullEvent,
      metadata: {
        sequenceNumber,
      },
    } as StoredEvent;
  }

  describe('Full Projection Rebuild', () => {
    it('should build projection from resource.created event', async () => {
      const events = [
        createStoredEvent({
          type: 'yield:created',
          resourceId: resourceId('doc1'),
          userId: userId('user1'),
          payload: {
            name: 'Test Resource',
            format: 'text/markdown',
            contentChecksum: 'hash123',
            entityTypes: ['note'],
          },
        }, 1),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view).not.toBeNull();
      expect(view!.resource['@id']).toContain('doc1'); // @id is HTTP URI containing doc1
      expect(view!.resource.name).toBe('Test Resource');
      const primaryRep = getPrimaryRepresentation(view!.resource);
      expect(primaryRep?.mediaType).toBe('text/markdown');
      expect(view!.resource.entityTypes).toEqual(['note']);
      expect(view!.resource.archived).toBe(false);
      expect(view!.annotations.version).toBe(1);
      expect(view!.annotations.annotations).toHaveLength(0);
    });

    it('should apply resource.archived event', async () => {
      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:archived',
          payload: {},
        }, 2),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view!.resource.archived).toBe(true);
      expect(view!.annotations.version).toBe(2);
    });

    it('should apply resource.unarchived event', async () => {
      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:archived',
          payload: {},
        }, 2),
        createStoredEvent({
          type: 'mark:unarchived',
          payload: {},
        }, 3),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view!.resource.archived).toBe(false);
      expect(view!.annotations.version).toBe(3);
    });

    it('should apply entitytag.added event', async () => {
      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', entityTypes: [] },
        }, 1),
        createStoredEvent({
          type: 'mark:entity-tag-added',
          payload: { entityType: 'Person' },
        }, 2),
        createStoredEvent({
          type: 'mark:entity-tag-added',
          payload: { entityType: 'Organization' },
        }, 3),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view!.resource.entityTypes).toEqual(['Person', 'Organization']);
      expect(view!.annotations.version).toBe(3);
    });

    it('should apply entitytag.removed event', async () => {
      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', entityTypes: ['Person', 'Organization'] },
        }, 1),
        createStoredEvent({
          type: 'mark:entity-tag-removed',
          payload: { entityType: 'Person' },
        }, 2),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view!.resource.entityTypes).toEqual(['Organization']);
      expect(view!.annotations.version).toBe(2);
    });

    // JOB-RESTART-SAFETY P6: at-least-once is a property of the network, not a
    // bug to be prevented upstream. A worker that commits a unit and loses the
    // acknowledgement in transit MUST retry, and the retry re-sends facts that
    // already landed — the append succeeded before the ack was lost, so no
    // pre-append check can stop it. P3 made annotation ids deterministic so
    // that repeat is recognizable; this fold is what makes it harmless.
    //
    // It is also what the projection doctrine already required: a view is a
    // derivation of the log, so it must answer "annotation X exists", never
    // "X was written twice". The previous blind push made the view depend on
    // how many times a fact was recorded rather than on what the facts mean.
    it('folds a repeated mark:added by id — a retried commit yields ONE annotation', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno-retried'),
        motivation: 'highlighting' as const,
        creator: { '@type': 'Person' as const, name: 'Test User' },
        created: new Date().toISOString(),
        target: { source: 'doc1', selector: [{ type: 'TextPositionSelector' as const, start: 0, end: 4 }] },
      };

      const view = await projector.materialize([
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({ type: 'mark:added', payload: { annotation } }, 2),
        // The retry: same id, same content, appended again.
        createStoredEvent({ type: 'mark:added', payload: { annotation } }, 3),
      ], resourceId('doc-retried'));

      expect(view!.annotations.annotations).toHaveLength(1);
      expect(view!.annotations.annotations[0]?.id).toBe('anno-retried');
    });

    it('a repeat does not resurrect an annotation that was removed after it', async () => {
      // Ordering still decides. The fold must not treat "already seen" as
      // "ignore forever" — a remove between two appends is a later fact, and
      // the second append legitimately re-creates.
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno-cycle'),
        motivation: 'highlighting' as const,
        creator: { '@type': 'Person' as const, name: 'Test User' },
        created: new Date().toISOString(),
        target: { source: 'doc1', selector: [{ type: 'TextPositionSelector' as const, start: 0, end: 4 }] },
      };

      const view = await projector.materialize([
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({ type: 'mark:added', payload: { annotation } }, 2),
        createStoredEvent({ type: 'mark:removed', payload: { annotationId: annotationId('anno-cycle') } }, 3),
        createStoredEvent({ type: 'mark:added', payload: { annotation } }, 4),
      ], resourceId('doc-cycle'));

      expect(view!.annotations.annotations).toHaveLength(1);
    });

    // The repeat is NOT byte-identical, which is exactly what the previous
    // last-write-wins fold assumed. `created` is stamped at EMISSION
    // (`processors.ts`, `new Date().toISOString()`) and is deliberately not an
    // identity input — P3 excluded it so a recovery re-emitting at a different
    // time from a different process still collides. So a retry always arrives
    // with a FRESH timestamp, and taking the newer payload silently advanced
    // `created` to the recovery time.
    //
    // This view is read by consumers (e.g. `make-meaning/annotation-context.ts`),
    // and it must answer when the annotation was MADE, not when a retry
    // happened to re-send it. Scope, measured: the graph projection is NOT
    // affected — it mints its own write time in `buildAnnotation` and the
    // worker's stamp never reaches it.
    it('a repeat does not advance created — the first append is when the annotation was made', async () => {
      const base = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno-created'),
        motivation: 'highlighting' as const,
        creator: { '@type': 'Person' as const, name: 'Test User' },
        target: { source: 'doc1', selector: [{ type: 'TextPositionSelector' as const, start: 0, end: 4 }] },
      };
      const firstCreated = '2026-09-03T10:00:00.000Z';
      const retryCreated = '2026-09-04T17:30:00.000Z';

      const view = await projector.materialize([
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({ type: 'mark:added', payload: { annotation: { ...base, created: firstCreated } } }, 2),
        // The recovery: same annotation, same id by construction, new stamp.
        createStoredEvent({ type: 'mark:added', payload: { annotation: { ...base, created: retryCreated } } }, 3),
      ], resourceId('doc-created'));

      expect(view!.annotations.annotations).toHaveLength(1);
      expect(view!.annotations.annotations[0]?.created).toBe(firstCreated);
    });

    it('should apply annotation.added event', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno1'),
        motivation: 'highlighting' as const,
        creator: { '@type': 'Person' as const, name: 'Test User' },
        created: new Date().toISOString(),
        target: {
          source: 'doc1',
          selector: [
            {
              type: 'TextPositionSelector' as const,
              start: 0,
              end: 16,
            },
            {
              type: 'TextQuoteSelector' as const,
              exact: 'highlighted text',
            },
          ],
        },
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:added',
          payload: { annotation },
        }, 2),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view!.annotations.annotations).toHaveLength(1);
      expect(view!.annotations.annotations[0]?.id).toBe('anno1');
      expect(view!.annotations.annotations[0]?.creator).toBeDefined();
      expect(view!.annotations.annotations[0]?.created).toBeDefined();
      expect(view!.annotations.version).toBe(2);
    });

    it('should apply annotation.removed event', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno1'),
        motivation: 'highlighting' as const,
        target: { source: 'doc1' },
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'mark:removed',
          payload: { annotationId: annotationId('anno1') },
        }, 3),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view!.annotations.annotations).toHaveLength(0);
      expect(view!.annotations.version).toBe(3);
    });

    it('should apply annotation.body.updated event - add operation', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno1'),
        motivation: 'highlighting' as const,
        target: { source: 'doc1' },
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'mark:body-updated',
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              { op: 'add' as const, item: { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const } },
            ],
          },
        }, 3),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      const body = view!.annotations.annotations[0]?.body;
      expect(Array.isArray(body) ? body : []).toHaveLength(1);
      expect(Array.isArray(body) ? body[0] : null).toEqual({
        type: 'TextualBody',
        value: 'Person',
        purpose: 'tagging',
      });
      expect(view!.annotations.annotations[0]?.modified).toBeDefined();
      expect(view!.annotations.version).toBe(3);
    });

    it('should apply annotation.body.updated event - remove operation', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno1'),
        motivation: 'highlighting' as const,
        target: { source: 'doc1' },
        body: [
          { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const },
          { type: 'TextualBody' as const, value: 'Organization', purpose: 'tagging' as const },
        ],
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'mark:body-updated',
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              { op: 'remove' as const, item: { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const } },
            ],
          },
        }, 3),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      const body = view!.annotations.annotations[0]?.body;
      expect(Array.isArray(body) ? body : []).toHaveLength(1);
      expect(Array.isArray(body) ? body[0] : null).toEqual({
        type: 'TextualBody',
        value: 'Organization',
        purpose: 'tagging',
      });
    });

    it('should apply annotation.body.updated event - replace operation', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId('anno1'),
        motivation: 'highlighting' as const,
        target: { source: 'doc1' },
        body: [
          { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const },
        ],
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'mark:body-updated',
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              {
                op: 'replace' as const,
                oldItem: { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const },
                newItem: { type: 'TextualBody' as const, value: 'Organization', purpose: 'tagging' as const },
              },
            ],
          },
        }, 3),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      const body = view!.annotations.annotations[0]?.body;
      expect(Array.isArray(body) ? body : []).toHaveLength(1);
      expect(Array.isArray(body) ? body[0] : null).toEqual({
        type: 'TextualBody',
        value: 'Organization',
        purpose: 'tagging',
      });
    });

    it('should handle multiple annotations', async () => {
      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
        createStoredEvent({
          type: 'mark:added',
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              'type': 'Annotation' as const,
              id: annotationId('anno1'),
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              modified: new Date().toISOString(),
            },
          },
        }, 2),
        createStoredEvent({
          type: 'mark:added',
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              'type': 'Annotation' as const,
              id: annotationId('anno2'),
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              modified: new Date().toISOString(),
            },
          },
        }, 3),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      expect(view!.annotations.annotations).toHaveLength(2);
      expect(view!.annotations.version).toBe(3);
    });

    it('should return null for empty event list', async () => {
      const view = await projector.materialize([], resourceId('doc1'));
      expect(view).toBeNull();
    });
  });

  describe('Incremental Updates', () => {
    it('should perform full rebuild when no projection exists', async () => {
      const events = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
      ];

      const getAllEvents = async () => events;

      await projector.materializeIncremental(resourceId('doc1'),
        events[0]!,
        getAllEvents
      );

      const view = await viewStorage.get(resourceId('doc1'));
      expect(view).not.toBeNull();
      expect(view!.resource.name).toBe('Test');
      expect(view!.annotations.version).toBe(1);
    });

    it('should apply event incrementally to existing projection', async () => {
      // Create initial projection
      const initialEvents = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', entityTypes: [] },
        }, 1),
      ];

      await projector.materialize(initialEvents, resourceId('doc1'));
      await viewStorage.save(resourceId('doc1'), (await projector.materialize(initialEvents, resourceId('doc1')))!);

      // Apply incremental update
      const newEvent = createStoredEvent({
        type: 'mark:entity-tag-added',
        payload: { entityType: 'Person' },
      }, 2);

      await projector.materializeIncremental(resourceId('doc1'),
        newEvent,
        async () => [...initialEvents, newEvent]
      );

      const view = await viewStorage.get(resourceId('doc1'));
      expect(view!.resource.entityTypes).toContain('Person');
      expect(view!.annotations.version).toBe(2);
    });

    it('should increment version on each update', async () => {
      const initialEvents = [
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', entityTypes: [] },
        }, 1),
      ];

      await projector.materialize(initialEvents, resourceId('doc1'));
      await viewStorage.save(resourceId('doc1'), (await projector.materialize(initialEvents, resourceId('doc1')))!);

      // Apply 3 incremental updates
      const events = [
        createStoredEvent({ type: 'mark:entity-tag-added', payload: { entityType: 'Person' } }, 2),
        createStoredEvent({ type: 'mark:entity-tag-added', payload: { entityType: 'Organization' } }, 3),
        createStoredEvent({ type: 'mark:archived', payload: {} }, 4),
      ];

      for (const event of events) {
        await projector.materializeIncremental(resourceId('doc1'),
          event,
          async () => [...initialEvents, ...events.slice(0, event.metadata.sequenceNumber)]
        );
      }

      const view = await viewStorage.get(resourceId('doc1'));
      expect(view!.annotations.version).toBe(4);
    });
  });

  describe('System Projections', () => {
    it('should update entity types projection', async () => {
      await projector.materializeEntityTypes('Person');
      await projector.materializeEntityTypes('Organization');

      const path = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(path, 'utf-8');
      const view = JSON.parse(content);

      expect(view.entityTypes).toContain('Person');
      expect(view.entityTypes).toContain('Organization');
    });

    it('should maintain sorted entity types', async () => {
      await projector.materializeEntityTypes('Zebra');
      await projector.materializeEntityTypes('Apple');
      await projector.materializeEntityTypes('Mango');

      const path = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(path, 'utf-8');
      const view = JSON.parse(content);

      expect(view.entityTypes).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('should be idempotent (adding same type multiple times)', async () => {
      await projector.materializeEntityTypes('Person');
      await projector.materializeEntityTypes('Person');
      await projector.materializeEntityTypes('Person');

      const path = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(path, 'utf-8');
      const view = JSON.parse(content);

      expect(view.entityTypes.filter((t: string) => t === 'Person')).toHaveLength(1);
    });
  });

  describe('Event Order', () => {
    it('should apply events in sequence number order', async () => {
      // Events out of order
      const events = [
        createStoredEvent({
          type: 'mark:added',
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              'type': 'Annotation' as const,
              id: annotationId('anno1'),
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              modified: new Date().toISOString(),
            },
          },
        }, 2),
        createStoredEvent({
          type: 'yield:created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1' },
        }, 1),
      ];

      const view = await projector.materialize(events, resourceId('doc1'));

      // Should apply resource.created first (sequence 1), then annotation.added (sequence 2)
      expect(view!.resource.name).toBe('Test');
      expect(view!.annotations.annotations).toHaveLength(1);
      expect(view!.annotations.version).toBe(2);
    });
  });
});
