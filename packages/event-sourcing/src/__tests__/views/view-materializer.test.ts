/**
 * ViewMaterializer Tests
 * Tests for complex view materialization logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ViewMaterializer } from '../../views/view-materializer';
import { FilesystemViewStorage } from '../../storage/view-storage';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, userId, annotationId } from '@semiont/core';
import type { EventMetadata, Motivation } from '@semiont/core';

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// Helper to create minimal EventMetadata for tests
function createEventMetadata(sequenceNumber: number): EventMetadata {
  return {
    sequenceNumber,
    streamPosition: sequenceNumber * 100,
  };
}

/** Create a flat StoredEvent from event fields and metadata */

describe('ViewMaterializer', () => {
  let materializer: ViewMaterializer;
  let project: SemiontProject;
  let viewStorage: FilesystemViewStorage;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-materializer-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });

    project = new SemiontProject(testDir);
    viewStorage = new FilesystemViewStorage(project);
    materializer = new ViewMaterializer(viewStorage, {
      basePath: testDir,
    });
  });

  afterEach(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('materialize() - Full rebuild from events', () => {
    it('should rebuild view from resource.created event', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view).not.toBeNull();
      expect(view?.resource.name).toBe('Test Document');
      // Format is now in representations array, not as a direct field
      const reps = Array.isArray(view?.resource.representations) ? view.resource.representations : [view?.resource.representations];
      expect(reps[0]?.mediaType).toBe('text/plain');
      expect(reps[0]?.rel).toBe('original');
    });

    it('should handle multiple representation.added events', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'yield:representation-added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              representation: {
                '@id': 'checksum2',
                mediaType: 'text/markdown',
                byteSize: 150,
                checksum: 'checksum2',
                created: new Date().toISOString(),
                rel: 'derived' as const,
              },
            },

          metadata: createEventMetadata(2),
        },
      ];

      const view = await materializer.materialize(events, rid);

      // Resource name remains immutable from creation event
      expect(view?.resource.name).toBe('Test Document');
      // We have original representation plus the added markdown representation
      expect(view?.resource.representations).toHaveLength(2);
      const reps = Array.isArray(view?.resource.representations) ? view.resource.representations : [view?.resource.representations];
      // First is original from resource.created
      expect(reps[0]?.mediaType).toBe('text/plain');
      expect(reps[0]?.rel).toBe('original');
      // Second is derived markdown from representation.added
      expect(reps[1]?.mediaType).toBe('text/markdown');
      expect(reps[1]?.rel).toBe('derived');
    });

    it('should handle representation.added event', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'yield:representation-added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              representation: {
                '@id': 'checksum1',
                mediaType: 'text/plain',
                byteSize: 100,
                checksum: 'checksum1',
                created: new Date().toISOString(),
              },
            },

          metadata: createEventMetadata(2),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.resource.representations).toHaveLength(1);
      const reps = Array.isArray(view?.resource.representations) ? view.resource.representations : [view?.resource.representations];
      expect(reps[0]?.checksum).toBe('checksum1');
    });

    it('should handle representation.removed event', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'yield:representation-added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              representation: {
                '@id': 'checksum1',
                mediaType: 'text/plain',
                byteSize: 100,
                checksum: 'checksum1',
                created: new Date().toISOString(),
              },
            },

          metadata: createEventMetadata(2),
        },
        {

            id: 'event3',
            type: 'yield:representation-removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 3,
            payload: {
              checksum: 'checksum1',
            },

          metadata: createEventMetadata(3),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.resource.representations).toHaveLength(0);
    });

    it('should handle annotation.added event', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'mark:added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                id: 'anno1',
                type: 'Annotation' as const,
                motivation: 'commenting' satisfies Motivation,
                body: [],
                target: 'doc1',
              },
            },

          metadata: createEventMetadata(2),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.annotations.annotations).toHaveLength(1);
    });

    it('should handle annotation.body.updated event', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'mark:added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                id: 'anno1',
                type: 'Annotation' as const,
                motivation: 'commenting' satisfies Motivation,
                body: [],
                target: 'doc1',
              },
            },

          metadata: createEventMetadata(2),
        },
        {

            id: 'event3',
            type: 'mark:body-updated',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 3,
            payload: {
              annotationId: annotationId('anno1'),
              operations: [
                {
                  op: 'add' as const,
                  item: {
                    type: 'TextualBody' as const,
                    value: 'Updated comment',
                    purpose: 'commenting' as const,
                  },
                },
              ],
            },

          metadata: createEventMetadata(3),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.annotations.annotations).toHaveLength(1);
      expect(view?.annotations.annotations[0].body).toHaveLength(1);
    });

    it('replays add + remove (with purpose) to produce empty body', async () => {
      // Regression guard: strict-purpose matching is the canonical case
      // where the caller knows which body they're removing.
      const rid = resourceId('doc1');
      const events: any[] = [
        {
          id: 'event1',
          type: 'yield:created',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 1,
          payload: {
            name: 'Test Document',
            format: 'text/plain' as const,
            contentChecksum: 'checksum1',
            creationMethod: 'api' as const,
          },
          metadata: createEventMetadata(1),
        },
        {
          id: 'event2',
          type: 'mark:added',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 2,
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              id: 'anno1',
              type: 'Annotation' as const,
              motivation: 'linking' satisfies Motivation,
              body: [],
              target: 'doc1',
            },
          },
          metadata: createEventMetadata(2),
        },
        {
          id: 'event3',
          type: 'mark:body-updated',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 3,
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              {
                op: 'add' as const,
                item: {
                  type: 'SpecificResource' as const,
                  source: 'target-doc',
                  purpose: 'linking' as const,
                },
              },
            ],
          },
          metadata: createEventMetadata(3),
        },
        {
          id: 'event4',
          type: 'mark:body-updated',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 4,
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              {
                op: 'remove' as const,
                item: {
                  type: 'SpecificResource' as const,
                  source: 'target-doc',
                  purpose: 'linking' as const,
                },
              },
            ],
          },
          metadata: createEventMetadata(4),
        },
      ];

      const view = await materializer.materialize(events, rid);
      expect(view?.annotations.annotations).toHaveLength(1);
      expect(view?.annotations.annotations[0].body).toEqual([]);
    });

    it('replays add + remove (without purpose) to produce empty body', async () => {
      // The regression this fix was written for. Event 7 in the user's KB
      // had a remove op with no `purpose` field; strict-purpose matching
      // in findBodyItem silently failed, leaving the link in place forever.
      // After the fix, purpose-less removes match by identity alone.
      const rid = resourceId('doc1');
      const events: any[] = [
        {
          id: 'event1',
          type: 'yield:created',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 1,
          payload: {
            name: 'Test Document',
            format: 'text/plain' as const,
            contentChecksum: 'checksum1',
            creationMethod: 'api' as const,
          },
          metadata: createEventMetadata(1),
        },
        {
          id: 'event2',
          type: 'mark:added',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 2,
          payload: {
            annotation: {
              '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
              id: 'anno1',
              type: 'Annotation' as const,
              motivation: 'linking' satisfies Motivation,
              body: [],
              target: 'doc1',
            },
          },
          metadata: createEventMetadata(2),
        },
        {
          id: 'event3',
          type: 'mark:body-updated',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 3,
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              {
                op: 'add' as const,
                item: {
                  type: 'SpecificResource' as const,
                  source: 'target-doc',
                  purpose: 'linking' as const,
                },
              },
            ],
          },
          metadata: createEventMetadata(3),
        },
        {
          id: 'event4',
          type: 'mark:body-updated',
          timestamp: new Date().toISOString(),
          userId: userId('user1'),
          resourceId: rid,
          version: 4,
          payload: {
            annotationId: annotationId('anno1'),
            operations: [
              {
                op: 'remove' as const,
                // Note: no `purpose` on the remove item — this is the
                // historical shape event-sourcing replay must handle.
                item: {
                  type: 'SpecificResource' as const,
                  source: 'target-doc',
                },
              },
            ],
          },
          metadata: createEventMetadata(4),
        },
      ];

      const view = await materializer.materialize(events, rid);
      expect(view?.annotations.annotations).toHaveLength(1);
      expect(view?.annotations.annotations[0].body).toEqual([]);
    });

    it('should handle annotation.removed event', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'mark:added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                id: 'anno1',
                type: 'Annotation' as const,
                motivation: 'commenting' satisfies Motivation,
                body: [],
                target: 'doc1',
              },
            },

          metadata: createEventMetadata(2),
        },
        {

            id: 'event3',
            type: 'mark:removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 3,
            payload: {
              annotationId: annotationId('anno1'),
            },

          metadata: createEventMetadata(3),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.annotations.annotations).toHaveLength(0);
    });

    it('should return null for empty event list', async () => {
      const rid = resourceId('doc1');
      const view = await materializer.materialize([], rid);

      expect(view).toBeNull();
    });
  });

  describe('materializeIncremental() - Incremental updates', () => {
    it('should incrementally add representation to existing view', async () => {
      const rid = resourceId('doc1');

      // Create initial view
      const createEvent = {
        id: 'event1',
        type: 'yield:created' as const,
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        resourceId: rid,
        version: 1,
        payload: {
          name: 'Test Document',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      };

      await materializer.materializeIncremental(rid, createEvent, async () => [
        { ...createEvent, metadata: createEventMetadata(1) },
      ] as any);

      // Add representation incrementally
      const addRepEvent = {
        id: 'event2',
        type: 'yield:representation-added' as const,
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        resourceId: rid,
        version: 2,
        payload: {
          representation: {
            '@id': 'checksum2',
            mediaType: 'application/pdf',
            byteSize: 2048,
            checksum: 'checksum2',
            created: new Date().toISOString(),
            rel: 'derived' as const,
          },
        },
      };

      await materializer.materializeIncremental(rid, addRepEvent, async () => [
        { ...createEvent, metadata: createEventMetadata(1) },
        { ...addRepEvent, metadata: createEventMetadata(2) },
      ] as any);

      const view = await viewStorage.get(rid);
      expect(view?.resource.name).toBe('Test Document');
      expect(view?.resource.representations).toHaveLength(2);
      const reps = Array.isArray(view?.resource.representations) ? view.resource.representations : [view?.resource.representations];
      // First is original from resource.created
      expect(reps[0]?.mediaType).toBe('text/plain');
      // Second is derived PDF from representation.added
      expect(reps[1]?.mediaType).toBe('application/pdf');
    });

    it('should rebuild from scratch if view does not exist', async () => {
      const rid = resourceId('doc1');

      const event = {
        id: 'event1',
        type: 'yield:created' as const,
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        resourceId: rid,
        version: 1,
        payload: {
          name: 'Test Document',
          format: 'text/plain' as const,
          contentChecksum: 'checksum1',
          creationMethod: 'api' as const,
        },
      };

      await materializer.materializeIncremental(rid, event, async () => [
        { ...event, metadata: createEventMetadata(1) },
      ] as any);

      const view = await viewStorage.get(rid);
      expect(view?.resource.name).toBe('Test Document');
    });
  });

  describe('materializeEntityTypes() - System views', () => {
    it('should create entity types view', async () => {
      const entityTypeId = 'http://example.com/entitytypes/Document';

      await materializer.materializeEntityTypes(entityTypeId);

      // Read the entity types file
      const entityTypesPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(entityTypesPath, 'utf-8');
      const view = JSON.parse(content);

      expect(view.entityTypes).toContain(entityTypeId);
    });

    it('should handle multiple entity types', async () => {
      const entityTypeId1 = 'http://example.com/entitytypes/Document';
      const entityTypeId2 = 'http://example.com/entitytypes/Image';

      await materializer.materializeEntityTypes(entityTypeId1);
      await materializer.materializeEntityTypes(entityTypeId2);

      // Read the entity types file
      const entityTypesPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(entityTypesPath, 'utf-8');
      const view = JSON.parse(content);

      expect(view.entityTypes).toHaveLength(2);
      expect(view.entityTypes).toContain(entityTypeId1);
      expect(view.entityTypes).toContain(entityTypeId2);
    });

    it('should be idempotent - adding same entity type twice', async () => {
      const entityTypeId = 'http://example.com/entitytypes/Document';

      await materializer.materializeEntityTypes(entityTypeId);
      await materializer.materializeEntityTypes(entityTypeId);

      // Read the entity types file
      const entityTypesPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(entityTypesPath, 'utf-8');
      const view = JSON.parse(content);

      // Should only have one copy
      expect(view.entityTypes).toHaveLength(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle multiple representations', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'yield:representation-added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              representation: {
                '@id': 'checksum1',
                mediaType: 'text/plain',
                byteSize: 100,
                checksum: 'checksum1',
                created: new Date().toISOString(),
              },
            },

          metadata: createEventMetadata(2),
        },
        {

            id: 'event3',
            type: 'yield:representation-added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 3,
            payload: {
              representation: {
                '@id': 'checksum2',
                mediaType: 'text/html',
                byteSize: 200,
                checksum: 'checksum2',
                created: new Date().toISOString(),
              },
            },

          metadata: createEventMetadata(3),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.resource.representations).toHaveLength(2);
    });

    it('should prevent duplicate representations', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'yield:representation-added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              representation: {
                '@id': 'checksum1',
                mediaType: 'text/plain',
                byteSize: 100,
                checksum: 'checksum1',
                created: new Date().toISOString(),
              },
            },

          metadata: createEventMetadata(2),
        },
        {

            id: 'event3',
            type: 'yield:representation-added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 3,
            payload: {
              representation: {
                '@id': 'checksum1',
                mediaType: 'text/plain',
                byteSize: 100,
                checksum: 'checksum1',
                created: new Date().toISOString(),
              },
            },

          metadata: createEventMetadata(3),
        },
      ];

      const view = await materializer.materialize(events, rid);

      // Should only have one representation (duplicates ignored)
      expect(view?.resource.representations).toHaveLength(1);
    });

    it('should handle removing non-existent representation gracefully', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'yield:representation-removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              checksum: 'nonexistent',
            },

          metadata: createEventMetadata(2),
        },
      ];

      const view = await materializer.materialize(events, rid);

      // Original representation from resource.created is still there
      expect(view?.resource.representations).toHaveLength(1);
      const reps = Array.isArray(view?.resource.representations) ? view.resource.representations : [view?.resource.representations];
      expect(reps[0]?.mediaType).toBe('text/plain');
      expect(reps[0]?.checksum).toBe('checksum1');
    });

    it('should handle deleting non-existent annotation gracefully', async () => {
      const rid = resourceId('doc1');
      const events: any[] = [
        {

            id: 'event1',
            type: 'yield:created',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 1,
            payload: {
              name: 'Test Document',
              format: 'text/plain' as const,
              contentChecksum: 'checksum1',
              creationMethod: 'api' as const,
            },

          metadata: createEventMetadata(1),
        },
        {

            id: 'event2',
            type: 'mark:removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotationId: annotationId('nonexistent'),
            },

          metadata: createEventMetadata(2),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.annotations.annotations).toHaveLength(0);
    });
  });

  describe('rebuildAll() - full startup rebuild', () => {
    /**
     * Build a fake RebuildEventSource (mirrors the EventLog interface that
     * rebuildAll consumes) backed by an in-memory map. We don't construct a
     * real EventLog here because the test is about the materializer's batching
     * behavior, not the storage layer's iteration semantics.
     */
    function fakeEventSource(streams: Record<string, any[]>) {
      return {
        async getEvents(rid: any) {
          return streams[rid as string] ?? [];
        },
        async getAllResourceIds() {
          return Object.keys(streams) as any[];
        },
      };
    }

    function createdEvent(rid: any, name: string, seq: number) {
      return {
        id: `evt-${rid}-${seq}`,
        type: 'yield:created',
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        resourceId: rid,
        version: 1,
        payload: {
          name,
          format: 'text/plain' as const,
          contentChecksum: `chk-${rid}`,
          creationMethod: 'api' as const,
        },
        metadata: createEventMetadata(seq),
      };
    }

    function entityTypeAddedEvent(entityType: string, seq: number) {
      return {
        id: `sys-evt-${seq}`,
        type: 'mark:entity-type-added',
        timestamp: new Date().toISOString(),
        userId: userId('user1'),
        version: 1,
        payload: { entityType },
        metadata: createEventMetadata(seq),
      };
    }

    it('rebuilds resource views and entity-types projection from a populated event log into an empty stateDir', async () => {
      const r1 = resourceId('doc1');
      const r2 = resourceId('doc2');

      const source = fakeEventSource({
        __system__: [
          entityTypeAddedEvent('Person', 1),
          entityTypeAddedEvent('Organization', 2),
          entityTypeAddedEvent('Location', 3),
        ],
        [r1 as string]: [createdEvent(r1, 'Doc One', 1)],
        [r2 as string]: [createdEvent(r2, 'Doc Two', 1)],
      });

      await materializer.rebuildAll(source);

      // Both resource views materialized
      const view1 = await viewStorage.get(r1);
      const view2 = await viewStorage.get(r2);
      expect(view1?.resource.name).toBe('Doc One');
      expect(view2?.resource.name).toBe('Doc Two');

      // Entity-types projection materialized
      const entityTypesPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const projection = JSON.parse(await fs.readFile(entityTypesPath, 'utf-8'));
      expect(projection.entityTypes).toEqual(['Location', 'Organization', 'Person']);
    });

    it('is idempotent: running twice produces the same state', async () => {
      const r1 = resourceId('doc1');
      const source = fakeEventSource({
        __system__: [entityTypeAddedEvent('Person', 1)],
        [r1 as string]: [createdEvent(r1, 'Doc One', 1)],
      });

      await materializer.rebuildAll(source);
      await materializer.rebuildAll(source);

      const view = await viewStorage.get(r1);
      expect(view?.resource.name).toBe('Doc One');

      const entityTypesPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const projection = JSON.parse(await fs.readFile(entityTypesPath, 'utf-8'));
      expect(projection.entityTypes).toEqual(['Person']);
    });

    it('overwrites stale resource views from a prior state', async () => {
      const r1 = resourceId('doc1');

      // Seed a stale view directly (simulates an earlier rebuild that no
      // longer matches the current event log)
      await viewStorage.save(r1, {
        resource: {
          '@context': 'https://schema.org/',
          '@id': r1 as string,
          name: 'Stale Name',
          representations: [],
          archived: false,
          entityTypes: [],
          creationMethod: 'api',
        },
        annotations: {
          resourceId: r1,
          annotations: [],
          version: 0,
          updatedAt: '',
        },
      });

      const source = fakeEventSource({
        [r1 as string]: [createdEvent(r1, 'Fresh Name', 1)],
      });

      await materializer.rebuildAll(source);

      const view = await viewStorage.get(r1);
      expect(view?.resource.name).toBe('Fresh Name');
    });

    it('handles a system-events-only log (no resource views to write)', async () => {
      const source = fakeEventSource({
        __system__: [entityTypeAddedEvent('Person', 1)],
      });

      await materializer.rebuildAll(source);

      const entityTypesPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const projection = JSON.parse(await fs.readFile(entityTypesPath, 'utf-8'));
      expect(projection.entityTypes).toEqual(['Person']);
    });

    it('handles a resource-events-only log (no entity-types projection written)', async () => {
      const r1 = resourceId('doc1');
      const source = fakeEventSource({
        [r1 as string]: [createdEvent(r1, 'Doc One', 1)],
      });

      await materializer.rebuildAll(source);

      const view = await viewStorage.get(r1);
      expect(view?.resource.name).toBe('Doc One');

      const entityTypesPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await expect(fs.access(entityTypesPath)).rejects.toThrow();
    });

    it('handles an empty event log without crashing', async () => {
      const source = fakeEventSource({});
      await expect(materializer.rebuildAll(source)).resolves.toBeUndefined();
    });
  });
});
