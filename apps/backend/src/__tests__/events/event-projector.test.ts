/**
 * EventProjector Tests - Projection building from events
 *
 * Tests Layer 2 → Layer 3 transformation, incremental updates, and system projections
 *
 * @see docs/EVENT-STORE.md#eventprojector
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventProjector } from '../../events/projections/event-projector';
import { FilesystemProjectionStorage } from '../../storage/projection-storage';
import type { StoredEvent, ResourceEvent } from '@semiont/core';
import { resourceId, userId, annotationId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getPrimaryRepresentation } from '../../utils/resource-helpers';

describe('EventProjector', () => {
  let testDir: string;
  let projector: EventProjector;
  let projectionStorage: FilesystemProjectionStorage;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-projector-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    projectionStorage = new FilesystemProjectionStorage(testDir);
    projector = new EventProjector(projectionStorage, {
      basePath: testDir,
      backendUrl: 'http://localhost:4000'
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create StoredEvent
  function createStoredEvent(event: Omit<ResourceEvent, 'id' | 'timestamp' | 'version' | 'userId'> & { userId?: string }, sequenceNumber: number): StoredEvent {
    const fullEvent: ResourceEvent = {
      id: `event-${sequenceNumber}`,
      userId: event.userId || 'user1',
      timestamp: new Date().toISOString(),
      version: 1,
      ...event,
    } as ResourceEvent;

    return {
      event: fullEvent,
      metadata: {
        sequenceNumber,
        streamPosition: sequenceNumber - 1,
        timestamp: fullEvent.timestamp,
        checksum: `checksum-${sequenceNumber}`,
        prevEventHash: sequenceNumber > 1 ? `checksum-${sequenceNumber - 1}` : undefined,
      },
    };
  }

  describe('Full Projection Rebuild', () => {
    it('should build projection from resource.created event', async () => {
      const events = [
        createStoredEvent({
          type: 'resource.created',
          resourceId: resourceId('doc1'),
          userId: userId('user1'),
          payload: {
            name: 'Test Resource',
            format: 'text/markdown',
            contentChecksum: 'hash123',
            creationMethod: 'api',
            entityTypes: ['note'],
          },
        }, 1),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection).not.toBeNull();
      expect(projection!.resource['@id']).toContain('doc1'); // @id is HTTP URI containing doc1
      expect(projection!.resource.name).toBe('Test Resource');
      const primaryRep = getPrimaryRepresentation(projection!.resource);
      expect(primaryRep?.mediaType).toBe('text/markdown');
      expect(projection!.resource.entityTypes).toEqual(['note']);
      expect(projection!.resource.archived).toBe(false);
      expect(projection!.annotations.version).toBe(1);
      expect(projection!.annotations.annotations).toHaveLength(0);
    });

    it('should apply resource.archived event', async () => {
      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'resource.archived',
          payload: {},
        }, 2),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection!.resource.archived).toBe(true);
      expect(projection!.annotations.version).toBe(2);
    });

    it('should apply resource.unarchived event', async () => {
      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'resource.archived',
          payload: {},
        }, 2),
        createStoredEvent({
          type: 'resource.unarchived',
          payload: {},
        }, 3),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection!.resource.archived).toBe(false);
      expect(projection!.annotations.version).toBe(3);
    });

    it('should apply entitytag.added event', async () => {
      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api', entityTypes: [] },
        }, 1),
        createStoredEvent({
          type: 'entitytag.added',
          payload: { entityType: 'Person' },
        }, 2),
        createStoredEvent({
          type: 'entitytag.added',
          payload: { entityType: 'Organization' },
        }, 3),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection!.resource.entityTypes).toEqual(['Person', 'Organization']);
      expect(projection!.annotations.version).toBe(3);
    });

    it('should apply entitytag.removed event', async () => {
      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api', entityTypes: ['Person', 'Organization'] },
        }, 1),
        createStoredEvent({
          type: 'entitytag.removed',
          payload: { entityType: 'Person' },
        }, 2),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection!.resource.entityTypes).toEqual(['Organization']);
      expect(projection!.annotations.version).toBe(2);
    });

    it('should apply annotation.added event', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: 'anno1',
        motivation: 'highlighting' as const,
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
        body: [],
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'annotation.added',
          payload: { annotation },
        }, 2),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection!.annotations.annotations).toHaveLength(1);
      expect(projection!.annotations.annotations[0]?.id).toBe('anno1');
      expect(projection!.annotations.annotations[0]?.creator).toBeDefined();
      expect(projection!.annotations.annotations[0]?.created).toBeDefined();
      expect(projection!.annotations.version).toBe(2);
    });

    it('should apply annotation.removed event', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: 'anno1',
        motivation: 'highlighting' as const,
        target: { source: 'doc1' },
        body: [],
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'annotation.added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'annotation.removed',
          payload: { annotationId: annotationId('anno1') },
        }, 3),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection!.annotations.annotations).toHaveLength(0);
      expect(projection!.annotations.version).toBe(3);
    });

    it('should apply annotation.body.updated event - add operation', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: 'anno1',
        motivation: 'highlighting' as const,
        target: { source: 'doc1' },
        body: [],
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'annotation.added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'annotation.body.updated',
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              { op: 'add' as const, item: { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const } },
            ],
          },
        }, 3),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      const body = projection!.annotations.annotations[0]?.body;
      expect(Array.isArray(body) ? body : []).toHaveLength(1);
      expect(Array.isArray(body) ? body[0] : null).toEqual({
        type: 'TextualBody',
        value: 'Person',
        purpose: 'tagging',
      });
      expect(projection!.annotations.annotations[0]?.modified).toBeDefined();
      expect(projection!.annotations.version).toBe(3);
    });

    it('should apply annotation.body.updated event - remove operation', async () => {
      const annotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: 'anno1',
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
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'annotation.added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'annotation.body.updated',
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              { op: 'remove' as const, item: { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const } },
            ],
          },
        }, 3),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      const body = projection!.annotations.annotations[0]?.body;
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
        id: 'anno1',
        motivation: 'highlighting' as const,
        target: { source: 'doc1' },
        body: [
          { type: 'TextualBody' as const, value: 'Person', purpose: 'tagging' as const },
        ],
        modified: new Date().toISOString(),
      };

      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'annotation.added',
          payload: { annotation },
        }, 2),
        createStoredEvent({
          type: 'annotation.body.updated',
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

      const projection = await projector.projectResource(events, resourceId('doc1'));

      const body = projection!.annotations.annotations[0]?.body;
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
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
        createStoredEvent({
          type: 'annotation.added',
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              'type': 'Annotation' as const,
              id: 'anno1',
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              body: [],
              modified: new Date().toISOString(),
            },
          },
        }, 2),
        createStoredEvent({
          type: 'annotation.added',
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              'type': 'Annotation' as const,
              id: 'anno2',
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              body: [],
              modified: new Date().toISOString(),
            },
          },
        }, 3),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      expect(projection!.annotations.annotations).toHaveLength(2);
      expect(projection!.annotations.version).toBe(3);
    });

    it('should return null for empty event list', async () => {
      const projection = await projector.projectResource([], resourceId('doc1'));
      expect(projection).toBeNull();
    });
  });

  describe('Incremental Updates', () => {
    it('should perform full rebuild when no projection exists', async () => {
      const events = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
      ];

      const getAllEvents = async () => events;

      await projector.updateProjectionIncremental(resourceId('doc1'),
        events[0]!.event,
        getAllEvents
      );

      const projection = await projectionStorage.get(resourceId('doc1'));
      expect(projection).not.toBeNull();
      expect(projection!.resource.name).toBe('Test');
      expect(projection!.annotations.version).toBe(1);
    });

    it('should apply event incrementally to existing projection', async () => {
      // Create initial projection
      const initialEvents = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api', entityTypes: [] },
        }, 1),
      ];

      await projector.projectResource(initialEvents, resourceId('doc1'));
      await projectionStorage.save(resourceId('doc1'), (await projector.projectResource(initialEvents, resourceId('doc1')))!);

      // Apply incremental update
      const newEvent = createStoredEvent({
        type: 'entitytag.added',
        payload: { entityType: 'Person' },
      }, 2);

      await projector.updateProjectionIncremental(resourceId('doc1'),
        newEvent.event,
        async () => [...initialEvents, newEvent]
      );

      const projection = await projectionStorage.get(resourceId('doc1'));
      expect(projection!.resource.entityTypes).toContain('Person');
      expect(projection!.annotations.version).toBe(2);
    });

    it('should increment version on each update', async () => {
      const initialEvents = [
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api', entityTypes: [] },
        }, 1),
      ];

      await projector.projectResource(initialEvents, resourceId('doc1'));
      await projectionStorage.save(resourceId('doc1'), (await projector.projectResource(initialEvents, resourceId('doc1')))!);

      // Apply 3 incremental updates
      const events = [
        createStoredEvent({ type: 'entitytag.added', payload: { entityType: 'Person' } }, 2),
        createStoredEvent({ type: 'entitytag.added', payload: { entityType: 'Organization' } }, 3),
        createStoredEvent({ type: 'resource.archived', payload: {} }, 4),
      ];

      for (const event of events) {
        await projector.updateProjectionIncremental(resourceId('doc1'),
          event.event,
          async () => [...initialEvents, ...events.slice(0, event.metadata.sequenceNumber)]
        );
      }

      const projection = await projectionStorage.get(resourceId('doc1'));
      expect(projection!.annotations.version).toBe(4);
    });
  });

  describe('System Projections', () => {
    it('should update entity types projection', async () => {
      await projector.updateEntityTypesProjection('Person');
      await projector.updateEntityTypesProjection('Organization');

      const path = join(testDir, 'projections', 'entity-types', 'entity-types.json');
      const content = await fs.readFile(path, 'utf-8');
      const projection = JSON.parse(content);

      expect(projection.entityTypes).toContain('Person');
      expect(projection.entityTypes).toContain('Organization');
    });

    it('should maintain sorted entity types', async () => {
      await projector.updateEntityTypesProjection('Zebra');
      await projector.updateEntityTypesProjection('Apple');
      await projector.updateEntityTypesProjection('Mango');

      const path = join(testDir, 'projections', 'entity-types', 'entity-types.json');
      const content = await fs.readFile(path, 'utf-8');
      const projection = JSON.parse(content);

      expect(projection.entityTypes).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('should be idempotent (adding same type multiple times)', async () => {
      await projector.updateEntityTypesProjection('Person');
      await projector.updateEntityTypesProjection('Person');
      await projector.updateEntityTypesProjection('Person');

      const path = join(testDir, 'projections', 'entity-types', 'entity-types.json');
      const content = await fs.readFile(path, 'utf-8');
      const projection = JSON.parse(content);

      expect(projection.entityTypes.filter((t: string) => t === 'Person')).toHaveLength(1);
    });
  });

  describe('Event Order', () => {
    it('should apply events in sequence number order', async () => {
      // Events out of order
      const events = [
        createStoredEvent({
          type: 'annotation.added',
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              'type': 'Annotation' as const,
              id: 'anno1',
              motivation: 'highlighting' as const,
              target: { source: 'doc1' },
              body: [],
              modified: new Date().toISOString(),
            },
          },
        }, 2),
        createStoredEvent({
          type: 'resource.created',
          payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: 'api' },
        }, 1),
      ];

      const projection = await projector.projectResource(events, resourceId('doc1'));

      // Should apply resource.created first (sequence 1), then annotation.added (sequence 2)
      expect(projection!.resource.name).toBe('Test');
      expect(projection!.annotations.annotations).toHaveLength(1);
      expect(projection!.annotations.version).toBe(2);
    });
  });
});
