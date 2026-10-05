/**
 * Entity Types Bootstrap Tests
 *
 * Tests the entity types bootstrap service:
 * - Initial bootstrap (emits frame:add-entity-type for all defaults)
 * - Idempotency (reads __system__ event log, skips existing types)
 * - Partial bootstrap (adds only missing types)
 * - The knowledge base as the actor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapEntityTypes } from '../../bootstrap/entity-types';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { type SemiontProject } from '@semiont/core/node';
import { userId, kbDid, resourceId, EventBus, type Logger, type GraphServiceConfig } from '@semiont/core';
import { createKnowledgeBase, type KnowledgeBase } from '../../knowledge-base';
import { Stower } from '../../stower';
import { getGraphDatabase } from '@semiont/graph';
import { createTestProject, TEST_KB_DOMAIN } from '../helpers/test-project';
import { createVectorStore } from '@semiont/vectors';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('Entity Types Bootstrap', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let kb: KnowledgeBase;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('bootstrap'));

    eventBus = new EventBus();
    eventStore = createEventStore(project, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, mockLogger, { vectorStore: await createVectorStore({ type: 'memory', dimensions: async () => 4 }) });
    stower = new Stower(kb, eventBus, project, mockLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('initial bootstrap', () => {
    it('should emit frame:entity-type-added for all DEFAULT_ENTITY_TYPES on fresh KB', async () => {
      await bootstrapEntityTypes(eventBus, eventStore, TEST_KB_DOMAIN);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'frame:entity-type-added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it("should emit every bootstrap event as the knowledge base's own DID", async () => {
      await bootstrapEntityTypes(eventBus, eventStore, TEST_KB_DOMAIN);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'frame:entity-type-added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
      addedEvents.forEach(event => {
        expect(event.userId).toBe(kbDid(TEST_KB_DOMAIN));
      });
    });

    it('should emit events in DEFAULT_ENTITY_TYPES order', async () => {
      await bootstrapEntityTypes(eventBus, eventStore, TEST_KB_DOMAIN);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'frame:entity-type-added');

      const emittedTypes = addedEvents.map(e =>
        e.type === 'frame:entity-type-added' ? e.payload.entityType : ''
      );
      expect(emittedTypes).toEqual(DEFAULT_ENTITY_TYPES);
    });
  });

  describe('idempotency', () => {
    it('should not emit duplicate events on second call', async () => {
      await bootstrapEntityTypes(eventBus, eventStore, TEST_KB_DOMAIN);
      await bootstrapEntityTypes(eventBus, eventStore, TEST_KB_DOMAIN);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'frame:entity-type-added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it('should only emit missing types when some already exist', async () => {
      // Manually add a few entity types
      const kbUserId = userId(kbDid(TEST_KB_DOMAIN));
      for (const tag of ['Person', 'Organization']) {
        eventBus.emit('frame:add-entity-type', { tag, _userId: kbUserId });
        await new Promise(r => setTimeout(r, 50));
      }

      const eventsBefore = await eventStore.log.getEvents(resourceId('__system__'));
      const beforeCount = eventsBefore.filter(e => e.type === 'frame:entity-type-added').length;
      expect(beforeCount).toBe(2);

      await bootstrapEntityTypes(eventBus, eventStore, TEST_KB_DOMAIN);

      const eventsAfter = await eventStore.log.getEvents(resourceId('__system__'));
      const afterCount = eventsAfter.filter(e => e.type === 'frame:entity-type-added').length;

      expect(afterCount).toBe(DEFAULT_ENTITY_TYPES.length);
      // Only the missing ones were added
      expect(afterCount - beforeCount).toBe(DEFAULT_ENTITY_TYPES.length - 2);
    });
  });
});
