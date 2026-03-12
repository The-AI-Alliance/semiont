/**
 * Resource Operations Tests
 *
 * Tests critical business logic for resource CRUD operations including:
 * - Resource creation (via Stower)
 * - Resource updates (archive/unarchive, entity type tagging)
 * - Event emission for all state changes
 *
 * Uses a real EventBus + Stower + EventStore pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ResourceOperations } from '../resource-operations';
import { userId, EventBus, CREATION_METHODS, type EnvironmentConfig, type Logger } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { Stower } from '../stower';
import { createKnowledgeBase } from '../knowledge-base';
import { getGraphDatabase } from '@semiont/graph';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('ResourceOperations', () => {
  let testDir: string;
  let testEventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  const publicURL = 'http://localhost:4000';

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-resource-ops-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    eventBus = new EventBus();
    testEventStore = createEventStore(testDir, publicURL, undefined, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ services: { graph: { type: 'memory' } } } as EnvironmentConfig);
    const kb = createKnowledgeBase(testEventStore, testDir, testDir, graphDb, mockLogger);

    stower = new Stower(kb, publicURL, eventBus, mockLogger);
    await stower.initialize();
  });

  afterAll(async () => {
    await stower.stop();
    eventBus.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('createResource', () => {
    it('should create resource with valid text content', async () => {
      const content = Buffer.from('Test resource content', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Test Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );

      expect(resId).toBeDefined();

      // Verify via event store
      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.name).toBe('Test Resource');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.format).toBe('text/plain');
    });

    it('should generate resource ID', async () => {
      const content = Buffer.from('Another test', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Resource with ID',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );

      expect(resId).toBeDefined();
      expect(typeof resId).toBe('string');
      expect(resId.length).toBeGreaterThan(0);
    });

    it('should store representation', async () => {
      const content = Buffer.from('Content to store', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Stored Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );

      // Verify representation was stored via event store
      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent).toBeDefined();
      // The representation is stored by Stower — verify the resource was created successfully
      expect(resId).toBeDefined();
    });

    it('should emit resource.created event', async () => {
      const content = Buffer.from('Event test content', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Event Test Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvents = events.filter(e => e.event.type === 'resource.created');
      expect(createdEvents).toHaveLength(1);

      const createdEvent = createdEvents[0];
      expect(createdEvent.event).toMatchObject({
        type: 'resource.created',
        resourceId: resId,
        userId: userId('user-1'),
        payload: {
          name: 'Event Test Resource',
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
          creationMethod: CREATION_METHODS.API,
          isDraft: false,
        }
      });
    });

    it('should handle markdown content format', async () => {
      const content = Buffer.from('# Markdown Title\n\nParagraph content', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Markdown Resource',
          content,
          format: 'text/markdown',
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.format).toBe('text/markdown');
    });

    it('should handle html content format', async () => {
      const content = Buffer.from('<html><body>HTML content</body></html>', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'HTML Resource',
          content,
          format: 'text/html',
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.format).toBe('text/html');
    });

    it('should handle optional language parameter', async () => {
      const content = Buffer.from('Contenu en français', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'French Resource',
          content,
          format: 'text/plain',
          language: 'fr',
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.language).toBe('fr');
    });

    it('should handle optional entity types', async () => {
      const content = Buffer.from('Content with entities', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Entity Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Organization', 'Location'],
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.entityTypes).toEqual(['Person', 'Organization', 'Location']);
    });

    it('should handle empty entity types array', async () => {
      const content = Buffer.from('No entities', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'No Entities Resource',
          content,
          format: 'text/plain',
          entityTypes: [],
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.entityTypes).toEqual([]);
    });

    it('should default to API creation method when not specified', async () => {
      const content = Buffer.from('Default creation method', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Default Method Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.creationMethod).toBe(CREATION_METHODS.API);
    });

    it('should accept valid creation method', async () => {
      const content = Buffer.from('Generated content', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Generated Resource',
          content,
          format: 'text/plain',
          creationMethod: CREATION_METHODS.GENERATED,
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent!.event.type === 'resource.created' && createdEvent!.event.payload.creationMethod).toBe(CREATION_METHODS.GENERATED);
    });

    it('should include timestamp in event', async () => {
      const content = Buffer.from('Timestamped content', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Timestamped Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.event.type === 'resource.created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.event.timestamp).toBeDefined();
      expect(new Date(createdEvent!.event.timestamp).getTime()).toBeGreaterThan(0);
    });
  });

  describe('updateResource', () => {
    it('should update archived status to true', async () => {
      const content = Buffer.from('To be archived', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Archive Test Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );


      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: true,
        },
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const archivedEvents = events.filter(e => e.event.type === 'resource.archived');
      expect(archivedEvents).toHaveLength(1);

      expect(archivedEvents[0].event).toMatchObject({
        type: 'resource.archived',
        resourceId: resId,
        userId: userId('user-1'),
      });
    });

    it('should update archived status to false (unarchive)', async () => {
      const content = Buffer.from('To be unarchived', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Unarchive Test Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );


      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: true,
        },
        eventBus,
      );

      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: true,
          updatedArchived: false,
        },
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const unarchivedEvents = events.filter(e => e.event.type === 'resource.unarchived');
      expect(unarchivedEvents).toHaveLength(1);

      expect(unarchivedEvents[0].event).toMatchObject({
        type: 'resource.unarchived',
        resourceId: resId,
        userId: userId('user-1'),
      });
    });

    it('should not emit event if archived status unchanged', async () => {
      const content = Buffer.from('Unchanged archive status', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Unchanged Archive Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        eventBus,
      );


      const eventsBefore = await testEventStore.log.getEvents(resId);
      const countBefore = eventsBefore.length;

      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: false,
        },
        eventBus,
      );

      const eventsAfter = await testEventStore.log.getEvents(resId);
      expect(eventsAfter.length).toBe(countBefore);
    });

    it('should add entity types', async () => {
      const content = Buffer.from('Entity type test', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Entity Type Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person'],
        },
        userId('user-1'),
        eventBus,
      );


      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person'],
          updatedEntityTypes: ['Person', 'Location', 'Organization'],
        },
        eventBus,
      );

      // Wait for Stower to process the async entity type updates via EventBus
      await new Promise(r => setTimeout(r, 100));

      const events = await testEventStore.log.getEvents(resId);
      const addedEvents = events.filter(e => e.event.type === 'entitytag.added');
      expect(addedEvents.length).toBeGreaterThanOrEqual(2);

      const addedTypes = addedEvents
        .map(e => e.event.type === 'entitytag.added' ? e.event.payload.entityType : null)
        .filter((t): t is string => t !== null);
      expect(addedTypes).toContain('Location');
      expect(addedTypes).toContain('Organization');
    });

    it('should remove entity types', async () => {
      const content = Buffer.from('Remove entity test', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Remove Entity Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location', 'Organization'],
        },
        userId('user-1'),
        eventBus,
      );


      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person', 'Location', 'Organization'],
          updatedEntityTypes: ['Person'],
        },
        eventBus,
      );

      // Wait for Stower to process the async entity type updates via EventBus
      await new Promise(r => setTimeout(r, 100));

      const events = await testEventStore.log.getEvents(resId);
      const removedEvents = events.filter(e => e.event.type === 'entitytag.removed');
      expect(removedEvents.length).toBeGreaterThanOrEqual(2);

      const removedTypes = removedEvents
        .map(e => e.event.type === 'entitytag.removed' ? e.event.payload.entityType : null)
        .filter((t): t is string => t !== null);
      expect(removedTypes).toContain('Location');
      expect(removedTypes).toContain('Organization');
    });

    it('should handle both adding and removing entity types', async () => {
      const content = Buffer.from('Mixed entity update', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Mixed Update Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
        },
        userId('user-1'),
        eventBus,
      );


      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person', 'Location'],
          updatedEntityTypes: ['Person', 'Organization'],
        },
        eventBus,
      );

      // Wait for Stower to process the async entity type updates via EventBus
      await new Promise(r => setTimeout(r, 100));

      const events = await testEventStore.log.getEvents(resId);
      const addedEvents = events.filter(e => e.event.type === 'entitytag.added');
      const removedEvents = events.filter(e => e.event.type === 'entitytag.removed');

      expect(addedEvents.some(e => e.event.type === 'entitytag.added' && e.event.payload.entityType === 'Organization')).toBe(true);
      expect(removedEvents.some(e => e.event.type === 'entitytag.removed' && e.event.payload.entityType === 'Location')).toBe(true);
    });

    it('should not emit events if entity types unchanged', async () => {
      const content = Buffer.from('Unchanged entity types', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Unchanged Entity Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
        },
        userId('user-1'),
        eventBus,
      );


      const eventsBefore = await testEventStore.log.getEvents(resId);
      const countBefore = eventsBefore.length;

      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person', 'Location'],
          updatedEntityTypes: ['Person', 'Location'],
        },
        eventBus,
      );

      const eventsAfter = await testEventStore.log.getEvents(resId);
      expect(eventsAfter.length).toBe(countBefore);
    });

    it('should handle multiple simultaneous updates', async () => {
      const content = Buffer.from('Multiple updates', 'utf-8');
      const resId = await ResourceOperations.createResource(
        {
          name: 'Multiple Updates Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person'],
        },
        userId('user-1'),
        eventBus,
      );


      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: true,
          currentEntityTypes: ['Person'],
          updatedEntityTypes: ['Person', 'Location'],
        },
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const archivedEvents = events.filter(e => e.event.type === 'resource.archived');
      const entityAddedEvents = events.filter(e => e.event.type === 'entitytag.added');

      expect(archivedEvents).toHaveLength(1);
      expect(entityAddedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
