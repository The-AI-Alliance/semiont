/**
 * ViewMaterializer Tests
 * Tests for complex view materialization logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ViewMaterializer } from '../../views/view-materializer';
import { FilesystemViewStorage } from '../../storage/view-storage';
import { resourceId, userId, annotationId } from '@semiont/core';
import type { StoredEvent, EventMetadata } from '@semiont/core';
import type { Motivation } from '@semiont/api-client';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Helper to create minimal EventMetadata for tests
function createEventMetadata(sequenceNumber: number, prevHash?: string): EventMetadata {
  return {
    sequenceNumber,
    streamPosition: sequenceNumber * 100,
    timestamp: new Date().toISOString(),
    prevEventHash: prevHash,
  };
}

describe('ViewMaterializer', () => {
  let materializer: ViewMaterializer;
  let viewStorage: FilesystemViewStorage;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-materializer-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    viewStorage = new FilesystemViewStorage(testDir);
    materializer = new ViewMaterializer(viewStorage, {
      basePath: testDir,
      backendUrl: 'http://localhost:4000',
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('materialize() - Full rebuild from events', () => {
    it('should rebuild view from resource.created event', async () => {
      const rid = resourceId('doc1');
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'representation.added',
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
          },
          metadata: createEventMetadata(2, 'hash1'),
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
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'representation.added',
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
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.resource.representations).toHaveLength(1);
      const reps = Array.isArray(view?.resource.representations) ? view.resource.representations : [view?.resource.representations];
      expect(reps[0]?.checksum).toBe('checksum1');
    });

    it('should handle representation.removed event', async () => {
      const rid = resourceId('doc1');
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'representation.added',
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
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
        {
          event: {
            id: 'event3',
            type: 'representation.removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 3,
            payload: {
              checksum: 'checksum1',
            },
          },
          metadata: createEventMetadata(3, 'hash2'),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.resource.representations).toHaveLength(0);
    });

    it('should handle annotation.added event', async () => {
      const rid = resourceId('doc1');
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'annotation.added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                id: 'http://localhost:4000/annotations/anno1',
                type: 'Annotation' as const,
                motivation: 'commenting' satisfies Motivation,
                body: [],
                target: 'http://localhost:4000/resources/doc1',
              },
            },
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.annotations.annotations).toHaveLength(1);
    });

    it('should handle annotation.body.updated event', async () => {
      const rid = resourceId('doc1');
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'annotation.added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                id: 'http://localhost:4000/annotations/anno1',
                type: 'Annotation' as const,
                motivation: 'commenting' satisfies Motivation,
                body: [],
                target: 'http://localhost:4000/resources/doc1',
              },
            },
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
        {
          event: {
            id: 'event3',
            type: 'annotation.body.updated',
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
          },
          metadata: createEventMetadata(3, 'hash2'),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.annotations.annotations).toHaveLength(1);
      expect(view?.annotations.annotations[0].body).toHaveLength(1);
    });

    it('should handle annotation.removed event', async () => {
      const rid = resourceId('doc1');
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'annotation.added',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotation: {
                '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
                id: 'http://localhost:4000/annotations/anno1',
                type: 'Annotation' as const,
                motivation: 'commenting' satisfies Motivation,
                body: [],
                target: 'http://localhost:4000/resources/doc1',
              },
            },
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
        {
          event: {
            id: 'event3',
            type: 'annotation.removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 3,
            payload: {
              annotationId: annotationId('anno1'),
            },
          },
          metadata: createEventMetadata(3, 'hash2'),
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
        type: 'resource.created' as const,
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
        {
          event: createEvent,
          metadata: createEventMetadata(1),
        },
      ]);

      // Add representation incrementally
      const addRepEvent = {
        id: 'event2',
        type: 'representation.added' as const,
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
        {
          event: createEvent,
          metadata: createEventMetadata(1),
        },
        {
          event: addRepEvent,
          metadata: createEventMetadata(2, 'hash1'),
        },
      ]);

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
        type: 'resource.created' as const,
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
        {
          event,
          metadata: createEventMetadata(1),
        },
      ]);

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
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'representation.added',
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
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
        {
          event: {
            id: 'event3',
            type: 'representation.added',
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
          },
          metadata: createEventMetadata(3, 'hash2'),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.resource.representations).toHaveLength(2);
    });

    it('should prevent duplicate representations', async () => {
      const rid = resourceId('doc1');
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'representation.added',
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
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
        {
          event: {
            id: 'event3',
            type: 'representation.added',
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
          },
          metadata: createEventMetadata(3, 'hash2'),
        },
      ];

      const view = await materializer.materialize(events, rid);

      // Should only have one representation (duplicates ignored)
      expect(view?.resource.representations).toHaveLength(1);
    });

    it('should handle removing non-existent representation gracefully', async () => {
      const rid = resourceId('doc1');
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'representation.removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              checksum: 'nonexistent',
            },
          },
          metadata: createEventMetadata(2, 'hash1'),
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
      const events: StoredEvent[] = [
        {
          event: {
            id: 'event1',
            type: 'resource.created',
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
          },
          metadata: createEventMetadata(1),
        },
        {
          event: {
            id: 'event2',
            type: 'annotation.removed',
            timestamp: new Date().toISOString(),
            userId: userId('user1'),
            resourceId: rid,
            version: 2,
            payload: {
              annotationId: annotationId('nonexistent'),
            },
          },
          metadata: createEventMetadata(2, 'hash1'),
        },
      ];

      const view = await materializer.materialize(events, rid);

      expect(view?.annotations.annotations).toHaveLength(0);
    });
  });
});
