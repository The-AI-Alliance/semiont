/**
 * Resource Operations Tests
 *
 * Tests critical business logic for resource CRUD operations including:
 * - Resource creation (ID generation, content storage, event emission)
 * - Resource updates (archive/unarchive, entity type tagging)
 * - Event emission for all state changes
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ResourceOperations } from '../resource-operations';
import { resourceId, userId, type EnvironmentConfig, CREATION_METHODS, type Logger } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore, type RepresentationStore } from '@semiont/content';
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
  let testRepStore: RepresentationStore;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-resource-ops-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration
    config = {
      services: {
        filesystem: {
          platform: { type: 'posix' },
          path: testDir
        },
        backend: {
          platform: { type: 'posix' },
          port: 4000,
          publicURL: 'http://localhost:4000',
          corsOrigin: 'http://localhost:3000'
        },
        inference: {
          platform: { type: 'external' },
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          endpoint: 'https://api.anthropic.com',
          apiKey: 'test-api-key'
        },
        graph: {
          platform: { type: 'posix' },
          type: 'memory'
        }
      },
      site: {
        siteName: 'Test Site',
        domain: 'localhost:3000',
        adminEmail: 'admin@test.local',
        oauthAllowedDomains: ['test.local']
      },
      _metadata: {
        environment: 'test',
        projectRoot: testDir
      },
    } as EnvironmentConfig;

    // Initialize event store and representation store
    testEventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);
    testRepStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('createResource', () => {
    it('should create resource with valid text content', async () => {
      const content = Buffer.from('Test resource content', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Test Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      expect(response).toBeDefined();
      expect(response.resource).toBeDefined();
      expect(response.resource.name).toBe('Test Resource');
      expect(response.resource.archived).toBe(false);
      const reps = Array.isArray(response.resource.representations) ? response.resource.representations : [response.resource.representations];
      expect(reps).toHaveLength(1);
      expect(reps[0].mediaType).toBe('text/plain');
      expect(response.annotations).toEqual([]);
    });

    it('should generate resource ID', async () => {
      const content = Buffer.from('Another test', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Resource with ID',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      expect(response.resource['@id']).toBeDefined();
      expect(response.resource['@id']).toMatch(/^http:\/\/localhost:4000\/resources\//);
    });

    it('should store representation', async () => {
      const content = Buffer.from('Content to store', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Stored Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const reps1 = Array.isArray(response.resource.representations) ? response.resource.representations : [response.resource.representations];
      expect(reps1).toHaveLength(1);
      const rep = reps1[0];
      expect(rep.checksum).toBeDefined();
      expect(rep.byteSize).toBe(content.length);
      expect(rep.rel).toBe('original');
    });

    it('should emit resource.created event', async () => {
      const content = Buffer.from('Event test content', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Event Test Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      // Extract resource ID from response
      const idMatch = response.resource['@id'].match(/\/resources\/(.+)$/);
      expect(idMatch).toBeDefined();
      const resId = resourceId(idMatch![1]);

      // Check event was emitted
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
      const response = await ResourceOperations.createResource(
        {
          name: 'Markdown Resource',
          content,
          format: 'text/markdown',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const reps0 = Array.isArray(response.resource.representations) ? response.resource.representations : [response.resource.representations];
      expect(reps0[0].mediaType).toBe('text/markdown');
    });

    it('should handle html content format', async () => {
      const content = Buffer.from('<html><body>HTML content</body></html>', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'HTML Resource',
          content,
          format: 'text/html',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const reps0 = Array.isArray(response.resource.representations) ? response.resource.representations : [response.resource.representations];
      expect(reps0[0].mediaType).toBe('text/html');
    });

    it('should handle optional language parameter', async () => {
      const content = Buffer.from('Contenu en français', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'French Resource',
          content,
          format: 'text/plain',
          language: 'fr',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const reps3 = Array.isArray(response.resource.representations) ? response.resource.representations : [response.resource.representations];
      expect(reps3[0].language).toBe('fr');
    });

    it('should handle optional entity types', async () => {
      const content = Buffer.from('Content with entities', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Entity Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Organization', 'Location'],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      expect(response.resource.entityTypes).toEqual(['Person', 'Organization', 'Location']);
    });

    it('should handle empty entity types array', async () => {
      const content = Buffer.from('No entities', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'No Entities Resource',
          content,
          format: 'text/plain',
          entityTypes: [],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      expect(response.resource.entityTypes).toEqual([]);
    });

    it('should default to API creation method when not specified', async () => {
      const content = Buffer.from('Default creation method', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Default Method Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      expect(response.resource.creationMethod).toBe(CREATION_METHODS.API);
    });

    it('should accept valid creation method', async () => {
      const content = Buffer.from('Generated content', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Generated Resource',
          content,
          format: 'text/plain',
          creationMethod: CREATION_METHODS.GENERATED,
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      expect(response.resource.creationMethod).toBe(CREATION_METHODS.GENERATED);
    });

    it('should include dateCreated timestamp', async () => {
      const content = Buffer.from('Timestamped content', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'Timestamped Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      expect(response.resource.dateCreated).toBeDefined();
      if (response.resource.dateCreated) {
        expect(new Date(response.resource.dateCreated).getTime()).toBeGreaterThan(0);
      }
    });
  });

  describe('updateResource', () => {
    it('should update archived status to true', async () => {
      // Create a resource first
      const content = Buffer.from('To be archived', 'utf-8');
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Archive Test Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      // Update to archived
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: true,
        },
        testEventStore
      );

      // Check event was emitted
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
      // Create and archive a resource
      const content = Buffer.from('To be unarchived', 'utf-8');
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Unarchive Test Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      // First archive it
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: true,
        },
        testEventStore
      );

      // Then unarchive it
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: true,
          updatedArchived: false,
        },
        testEventStore
      );

      // Check unarchive event was emitted
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
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Unchanged Archive Resource',
          content,
          format: 'text/plain',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      const eventsBefore = await testEventStore.log.getEvents(resId);
      const countBefore = eventsBefore.length;

      // Update with same archived status
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: false,
        },
        testEventStore
      );

      const eventsAfter = await testEventStore.log.getEvents(resId);
      expect(eventsAfter.length).toBe(countBefore); // No new events
    });

    it('should add entity types', async () => {
      const content = Buffer.from('Entity type test', 'utf-8');
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Entity Type Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person'],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      // Add entity types
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person'],
          updatedEntityTypes: ['Person', 'Location', 'Organization'],
        },
        testEventStore
      );

      // Check entitytag.added events were emitted
      const events = await testEventStore.log.getEvents(resId);
      const addedEvents = events.filter(e => e.event.type === 'entitytag.added');
      expect(addedEvents.length).toBeGreaterThanOrEqual(2); // Location and Organization

      const addedTypes = addedEvents
        .map(e => e.event.type === 'entitytag.added' ? e.event.payload.entityType : null)
        .filter((t): t is string => t !== null);
      expect(addedTypes).toContain('Location');
      expect(addedTypes).toContain('Organization');
    });

    it('should remove entity types', async () => {
      const content = Buffer.from('Remove entity test', 'utf-8');
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Remove Entity Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location', 'Organization'],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      // Remove entity types
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person', 'Location', 'Organization'],
          updatedEntityTypes: ['Person'],
        },
        testEventStore
      );

      // Check entitytag.removed events were emitted
      const events = await testEventStore.log.getEvents(resId);
      const removedEvents = events.filter(e => e.event.type === 'entitytag.removed');
      expect(removedEvents.length).toBeGreaterThanOrEqual(2); // Location and Organization

      const removedTypes = removedEvents
        .map(e => e.event.type === 'entitytag.removed' ? e.event.payload.entityType : null)
        .filter((t): t is string => t !== null);
      expect(removedTypes).toContain('Location');
      expect(removedTypes).toContain('Organization');
    });

    it('should handle both adding and removing entity types', async () => {
      const content = Buffer.from('Mixed entity update', 'utf-8');
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Mixed Update Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      // Remove 'Location', add 'Organization'
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person', 'Location'],
          updatedEntityTypes: ['Person', 'Organization'],
        },
        testEventStore
      );

      const events = await testEventStore.log.getEvents(resId);
      const addedEvents = events.filter(e => e.event.type === 'entitytag.added');
      const removedEvents = events.filter(e => e.event.type === 'entitytag.removed');

      expect(addedEvents.some(e => e.event.type === 'entitytag.added' && e.event.payload.entityType === 'Organization')).toBe(true);
      expect(removedEvents.some(e => e.event.type === 'entitytag.removed' && e.event.payload.entityType === 'Location')).toBe(true);
    });

    it('should not emit events if entity types unchanged', async () => {
      const content = Buffer.from('Unchanged entity types', 'utf-8');
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Unchanged Entity Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person', 'Location'],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      const eventsBefore = await testEventStore.log.getEvents(resId);
      const countBefore = eventsBefore.length;

      // Update with same entity types
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentEntityTypes: ['Person', 'Location'],
          updatedEntityTypes: ['Person', 'Location'],
        },
        testEventStore
      );

      const eventsAfter = await testEventStore.log.getEvents(resId);
      expect(eventsAfter.length).toBe(countBefore); // No new events
    });

    it('should handle multiple simultaneous updates', async () => {
      const content = Buffer.from('Multiple updates', 'utf-8');
      const createResponse = await ResourceOperations.createResource(
        {
          name: 'Multiple Updates Resource',
          content,
          format: 'text/plain',
          entityTypes: ['Person'],
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const idMatch = createResponse.resource['@id'].match(/\/resources\/(.+)$/);
      const resId = resourceId(idMatch![1]);

      // Update both archived status and entity types
      await ResourceOperations.updateResource(
        {
          resourceId: resId,
          userId: userId('user-1'),
          currentArchived: false,
          updatedArchived: true,
          currentEntityTypes: ['Person'],
          updatedEntityTypes: ['Person', 'Location'],
        },
        testEventStore
      );

      const events = await testEventStore.log.getEvents(resId);
      const archivedEvents = events.filter(e => e.event.type === 'resource.archived');
      const entityAddedEvents = events.filter(e => e.event.type === 'entitytag.added');

      expect(archivedEvents).toHaveLength(1);
      expect(entityAddedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
