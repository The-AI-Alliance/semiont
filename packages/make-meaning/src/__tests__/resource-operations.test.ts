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
import { type SemiontProject } from '@semiont/core/node';
import { userId, EventBus, CREATION_METHODS, type Logger, type GraphServiceConfig } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { Stower } from '../stower';
import { createKnowledgeBase } from '../knowledge-base';
import { getGraphDatabase } from '@semiont/graph';
import { deriveStorageUri } from '@semiont/content';
import type { KnowledgeBase } from '../knowledge-base';
import { createTestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

let fileCounter = 0;

describe('ResourceOperations', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let testEventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let kb: KnowledgeBase;

  /** Write content to disk then create resource via EventBus. */
  async function create(
    opts: { name: string; content: Buffer; format: 'text/plain' | 'text/markdown' | 'text/html'; language?: string; entityTypes?: string[]; creationMethod?: import('@semiont/core').CreationMethod },
    uid: import('@semiont/core').UserId,
  ) {
    const uri = deriveStorageUri(`test-${++fileCounter}`, opts.format);
    const stored = await kb.content.store(opts.content, uri);
    return ResourceOperations.createResource(
      { name: opts.name, storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format: opts.format, language: opts.language, entityTypes: opts.entityTypes, creationMethod: opts.creationMethod },
      uid,
      eventBus,
    );
  }

  beforeAll(async () => {
    ({ project, teardown } = await createTestProject('resource-ops'));

    eventBus = new EventBus();
    testEventStore = createEventStore(project, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    kb = await createKnowledgeBase(testEventStore, project, graphDb, eventBus, mockLogger);

    stower = new Stower(kb, eventBus, mockLogger);
    await stower.initialize();
  });

  afterAll(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('createResource', () => {
    it('should create resource with valid text content', async () => {
      const resId = await create(
        { name: 'Test Resource', content: Buffer.from('Test resource content', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      expect(resId).toBeDefined();

      // Verify via event store
      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.name).toBe('Test Resource');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.format).toBe('text/plain');
    });

    it('should generate resource ID', async () => {
      const resId = await create(
        { name: 'Resource with ID', content: Buffer.from('Another test', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      expect(resId).toBeDefined();
      expect(typeof resId).toBe('string');
      expect(resId.length).toBeGreaterThan(0);
    });

    it('should store representation', async () => {
      const resId = await create(
        { name: 'Stored Resource', content: Buffer.from('Content to store', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      expect(resId).toBeDefined();
    });

    it('should emit resource.created event', async () => {
      const resId = await create(
        { name: 'Event Test Resource', content: Buffer.from('Event test content', 'utf-8'), format: 'text/plain', entityTypes: ['Person', 'Location'] },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvents = events.filter(e => e.type === 'yield:created');
      expect(createdEvents).toHaveLength(1);

      const createdEvent = createdEvents[0];
      expect(createdEvent).toMatchObject({
        type: 'yield:created',
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
      const resId = await create(
        { name: 'Markdown Resource', content: Buffer.from('# Markdown Title\n\nParagraph content', 'utf-8'), format: 'text/markdown' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.format).toBe('text/markdown');
    });

    it('should handle html content format', async () => {
      const resId = await create(
        { name: 'HTML Resource', content: Buffer.from('<html><body>HTML content</body></html>', 'utf-8'), format: 'text/html' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.format).toBe('text/html');
    });

    it('should handle optional language parameter', async () => {
      const resId = await create(
        { name: 'French Resource', content: Buffer.from('Contenu en français', 'utf-8'), format: 'text/plain', language: 'fr' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.language).toBe('fr');
    });

    it('should handle optional entity types', async () => {
      const resId = await create(
        { name: 'Entity Resource', content: Buffer.from('Content with entities', 'utf-8'), format: 'text/plain', entityTypes: ['Person', 'Organization', 'Location'] },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.entityTypes).toEqual(['Person', 'Organization', 'Location']);
    });

    it('should handle empty entity types array', async () => {
      const resId = await create(
        { name: 'No Entities Resource', content: Buffer.from('No entities', 'utf-8'), format: 'text/plain', entityTypes: [] },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.entityTypes).toEqual([]);
    });

    it('should default to API creation method when not specified', async () => {
      const resId = await create(
        { name: 'Default Method Resource', content: Buffer.from('Default creation method', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.creationMethod).toBe(CREATION_METHODS.API);
    });

    it('should accept valid creation method', async () => {
      const resId = await create(
        { name: 'Generated Resource', content: Buffer.from('Generated content', 'utf-8'), format: 'text/plain', creationMethod: CREATION_METHODS.GENERATED },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.creationMethod).toBe(CREATION_METHODS.GENERATED);
    });

    it('should include timestamp in event', async () => {
      const resId = await create(
        { name: 'Timestamped Resource', content: Buffer.from('Timestamped content', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.timestamp).toBeDefined();
      expect(new Date(createdEvent!.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('should forward generation-provenance fields through to the persisted yield:created event', async () => {
      // Protects the generation-worker flow: the worker (via POST /resources)
      // passes generatedFrom / generationPrompt / generator / isDraft through
      // ResourceOperations.createResource. If any field is dropped on the floor
      // here, downstream readers (graph materializer, PROV-O query) silently
      // lose provenance with no runtime error.
      const generator = {
        '@type': 'SoftwareAgent' as const,
        name: 'worker-pool / ollama gemma4:26b',
        worker: 'worker-pool',
        inferenceProvider: 'ollama',
        model: 'gemma4:26b',
      };
      const uri = deriveStorageUri(`test-${++fileCounter}`, 'text/markdown');
      const stored = await kb.content.store(Buffer.from('# Generated\n', 'utf-8'), uri);
      const resId = await ResourceOperations.createResource(
        {
          name: 'Generated Doc',
          storageUri: stored.storageUri,
          contentChecksum: stored.checksum,
          byteSize: stored.byteSize,
          format: 'text/markdown',
          creationMethod: CREATION_METHODS.GENERATED,
          generatedFrom: { resourceId: 'res-parent', annotationId: 'ann-origin' },
          generationPrompt: 'Summarize the key points',
          generator,
          isDraft: true,
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      if (createdEvent && createdEvent.type === 'yield:created') {
        expect(createdEvent.payload).toMatchObject({
          name: 'Generated Doc',
          format: 'text/markdown',
          creationMethod: CREATION_METHODS.GENERATED,
          generatedFrom: { resourceId: 'res-parent', annotationId: 'ann-origin' },
          generationPrompt: 'Summarize the key points',
          generator,
          isDraft: true,
        });
      }
    });

    it('should omit generatedFrom from persisted event when only one side of the edge is provided', async () => {
      // Stower requires BOTH resourceId and annotationId to persist
      // generatedFrom (see handleYieldCreate). If only one is present
      // the field is dropped rather than persisted in a half-shape that
      // downstream code can't reason about. Pinning this behavior so a
      // future refactor doesn't silently relax it.
      const uri = deriveStorageUri(`test-${++fileCounter}`, 'text/plain');
      const stored = await kb.content.store(Buffer.from('partial', 'utf-8'), uri);
      const resId = await ResourceOperations.createResource(
        {
          name: 'Half-provenance Doc',
          storageUri: stored.storageUri,
          contentChecksum: stored.checksum,
          byteSize: stored.byteSize,
          format: 'text/plain',
          generatedFrom: { resourceId: 'res-only' }, // no annotationId
        },
        userId('user-1'),
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const createdEvent = events.find(e => e.type === 'yield:created');
      expect(createdEvent).toBeDefined();
      if (createdEvent && createdEvent.type === 'yield:created') {
        expect(createdEvent.payload.generatedFrom).toBeUndefined();
      }
    });
  });

  describe('updateResource', () => {
    it('should update archived status to true', async () => {
      const resId = await create(
        { name: 'Archive Test Resource', content: Buffer.from('To be archived', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentArchived: false, updatedArchived: true },
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const archivedEvents = events.filter(e => e.type === 'mark:archived');
      expect(archivedEvents).toHaveLength(1);
      expect(archivedEvents[0]).toMatchObject({ type: 'mark:archived', resourceId: resId, userId: userId('user-1') });
    });

    it('should update archived status to false (unarchive)', async () => {
      const resId = await create(
        { name: 'Unarchive Test Resource', content: Buffer.from('To be unarchived', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentArchived: false, updatedArchived: true },
        eventBus,
      );
      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentArchived: true, updatedArchived: false },
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const unarchivedEvents = events.filter(e => e.type === 'mark:unarchived');
      expect(unarchivedEvents).toHaveLength(1);
      expect(unarchivedEvents[0]).toMatchObject({ type: 'mark:unarchived', resourceId: resId, userId: userId('user-1') });
    });

    it('should not emit event if archived status unchanged', async () => {
      const resId = await create(
        { name: 'Unchanged Archive Resource', content: Buffer.from('Unchanged archive status', 'utf-8'), format: 'text/plain' },
        userId('user-1'),
      );

      const eventsBefore = await testEventStore.log.getEvents(resId);
      const countBefore = eventsBefore.length;

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentArchived: false, updatedArchived: false },
        eventBus,
      );

      const eventsAfter = await testEventStore.log.getEvents(resId);
      expect(eventsAfter.length).toBe(countBefore);
    });

    it('should add entity types', async () => {
      const resId = await create(
        { name: 'Entity Type Resource', content: Buffer.from('Entity type test', 'utf-8'), format: 'text/plain', entityTypes: ['Person'] },
        userId('user-1'),
      );

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentEntityTypes: ['Person'], updatedEntityTypes: ['Person', 'Location', 'Organization'] },
        eventBus,
      );

      await new Promise(r => setTimeout(r, 100));

      const events = await testEventStore.log.getEvents(resId);
      const addedEvents = events.filter(e => e.type === 'mark:entity-tag-added');
      expect(addedEvents.length).toBeGreaterThanOrEqual(2);

      const addedTypes = addedEvents
        .map(e => e.type === 'mark:entity-tag-added' ? e.payload.entityType : null)
        .filter((t): t is string => t !== null);
      expect(addedTypes).toContain('Location');
      expect(addedTypes).toContain('Organization');
    });

    it('should remove entity types', async () => {
      const resId = await create(
        { name: 'Remove Entity Resource', content: Buffer.from('Remove entity test', 'utf-8'), format: 'text/plain', entityTypes: ['Person', 'Location', 'Organization'] },
        userId('user-1'),
      );

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentEntityTypes: ['Person', 'Location', 'Organization'], updatedEntityTypes: ['Person'] },
        eventBus,
      );

      await new Promise(r => setTimeout(r, 100));

      const events = await testEventStore.log.getEvents(resId);
      const removedEvents = events.filter(e => e.type === 'mark:entity-tag-removed');
      expect(removedEvents.length).toBeGreaterThanOrEqual(2);

      const removedTypes = removedEvents
        .map(e => e.type === 'mark:entity-tag-removed' ? e.payload.entityType : null)
        .filter((t): t is string => t !== null);
      expect(removedTypes).toContain('Location');
      expect(removedTypes).toContain('Organization');
    });

    it('should handle both adding and removing entity types', async () => {
      const resId = await create(
        { name: 'Mixed Update Resource', content: Buffer.from('Mixed entity update', 'utf-8'), format: 'text/plain', entityTypes: ['Person', 'Location'] },
        userId('user-1'),
      );

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentEntityTypes: ['Person', 'Location'], updatedEntityTypes: ['Person', 'Organization'] },
        eventBus,
      );

      await new Promise(r => setTimeout(r, 100));

      const events = await testEventStore.log.getEvents(resId);
      const addedEvents = events.filter(e => e.type === 'mark:entity-tag-added');
      const removedEvents = events.filter(e => e.type === 'mark:entity-tag-removed');

      expect(addedEvents.some(e => e.type === 'mark:entity-tag-added' && e.payload.entityType === 'Organization')).toBe(true);
      expect(removedEvents.some(e => e.type === 'mark:entity-tag-removed' && e.payload.entityType === 'Location')).toBe(true);
    });

    it('should not emit events if entity types unchanged', async () => {
      const resId = await create(
        { name: 'Unchanged Entity Resource', content: Buffer.from('Unchanged entity types', 'utf-8'), format: 'text/plain', entityTypes: ['Person', 'Location'] },
        userId('user-1'),
      );

      const eventsBefore = await testEventStore.log.getEvents(resId);
      const countBefore = eventsBefore.length;

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentEntityTypes: ['Person', 'Location'], updatedEntityTypes: ['Person', 'Location'] },
        eventBus,
      );

      const eventsAfter = await testEventStore.log.getEvents(resId);
      expect(eventsAfter.length).toBe(countBefore);
    });

    it('should handle multiple simultaneous updates', async () => {
      const resId = await create(
        { name: 'Multiple Updates Resource', content: Buffer.from('Multiple updates', 'utf-8'), format: 'text/plain', entityTypes: ['Person'] },
        userId('user-1'),
      );

      await ResourceOperations.updateResource(
        { resourceId: resId, userId: userId('user-1'), currentArchived: false, updatedArchived: true, currentEntityTypes: ['Person'], updatedEntityTypes: ['Person', 'Location'] },
        eventBus,
      );

      const events = await testEventStore.log.getEvents(resId);
      const archivedEvents = events.filter(e => e.type === 'mark:archived');
      const entityAddedEvents = events.filter(e => e.type === 'mark:entity-tag-added');

      expect(archivedEvents).toHaveLength(1);
      expect(entityAddedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
