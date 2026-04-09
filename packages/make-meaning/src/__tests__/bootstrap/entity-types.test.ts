/**
 * Entity Types Bootstrap Tests
 *
 * Tests the entity types bootstrap service:
 * - Initial bootstrap (emits mark:add-entity-type for all defaults)
 * - Idempotency (reads __system__ event log, skips existing types)
 * - Partial bootstrap (adds only missing types)
 * - System user ID usage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapEntityTypes } from '../../bootstrap/entity-types';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { type SemiontProject } from '@semiont/core/node';
import { userId, resourceId, EventBus, type Logger, type GraphServiceConfig } from '@semiont/core';
import { createKnowledgeBase, type KnowledgeBase } from '../../knowledge-base';
import { Stower } from '../../stower';
import { getGraphDatabase } from '@semiont/graph';
import { createTestProject } from '../helpers/test-project';

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
    kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, mockLogger);
    stower = new Stower(kb, eventBus, mockLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('initial bootstrap', () => {
    it('should emit mark:entity-type-added for all DEFAULT_ENTITY_TYPES on fresh KB', async () => {
      await bootstrapEntityTypes(eventBus, eventStore);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'mark:entity-type-added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it('should use system user ID for bootstrap events', async () => {
      await bootstrapEntityTypes(eventBus, eventStore);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'mark:entity-type-added');

      const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');
      addedEvents.forEach(event => {
        expect(event.userId).toBe(SYSTEM_USER_ID);
      });
    });

    it('should emit events in DEFAULT_ENTITY_TYPES order', async () => {
      await bootstrapEntityTypes(eventBus, eventStore);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'mark:entity-type-added');

      const emittedTypes = addedEvents.map(e =>
        e.type === 'mark:entity-type-added' ? e.payload.entityType : ''
      );
      expect(emittedTypes).toEqual(DEFAULT_ENTITY_TYPES);
    });
  });

  describe('idempotency', () => {
    it('should not emit duplicate events on second call', async () => {
      await bootstrapEntityTypes(eventBus, eventStore);
      await bootstrapEntityTypes(eventBus, eventStore);

      const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
      const addedEvents = systemEvents.filter(e => e.type === 'mark:entity-type-added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it('should only emit missing types when some already exist', async () => {
      // Manually add a few entity types
      const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');
      for (const tag of ['Person', 'Organization']) {
        eventBus.get('mark:add-entity-type').next({ tag, userId: SYSTEM_USER_ID });
        await new Promise(r => setTimeout(r, 50));
      }

      const eventsBefore = await eventStore.log.getEvents(resourceId('__system__'));
      const beforeCount = eventsBefore.filter(e => e.type === 'mark:entity-type-added').length;
      expect(beforeCount).toBe(2);

      await bootstrapEntityTypes(eventBus, eventStore);

      const eventsAfter = await eventStore.log.getEvents(resourceId('__system__'));
      const afterCount = eventsAfter.filter(e => e.type === 'mark:entity-type-added').length;

      expect(afterCount).toBe(DEFAULT_ENTITY_TYPES.length);
      // Only the missing ones were added
      expect(afterCount - beforeCount).toBe(DEFAULT_ENTITY_TYPES.length - 2);
    });
  });
});
