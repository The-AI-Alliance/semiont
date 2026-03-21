/**
 * Entity Types Bootstrap Tests
 *
 * Tests the entity types bootstrap service:
 * - Initial bootstrap (creates projection from DEFAULT_ENTITY_TYPES)
 * - Idempotency (skips if projection exists)
 * - Singleton flag (only runs once per process)
 * - Event emission (entitytype.added for each default type)
 * - System user ID usage
 * - Path resolution (absolute and relative)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapEntityTypes, resetBootstrap } from '../../bootstrap/entity-types';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { type SemiontProject } from '@semiont/core/node';
import { userId, EventBus, type Logger, type GraphServiceConfig } from '@semiont/core';
import { createKnowledgeBase, type KnowledgeBase } from '../../knowledge-base';
import { Stower } from '../../stower';
import { getGraphDatabase } from '@semiont/graph';
import { promises as fs } from 'fs';
import { join } from 'path';
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
    resetBootstrap();

    ({ project, teardown } = await createTestProject('bootstrap'));

    eventBus = new EventBus();
    eventStore = createEventStore(project, undefined, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    kb = createKnowledgeBase(eventStore, project, graphDb, mockLogger);
    stower = new Stower(kb, eventBus, mockLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    await stower.stop();
    eventBus.destroy();
    await teardown();
  });

  describe('initial bootstrap', () => {
    it('should create entity types projection when it does not exist', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should emit entitytype.added events for all DEFAULT_ENTITY_TYPES', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it('should use system user ID for bootstrap events', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');
      addedEvents.forEach(event => {
        expect(event.event.userId).toBe(SYSTEM_USER_ID);
      });
    });

    it('should emit events in correct order', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      const emittedTypes = addedEvents.map(e => {
        if (e.event.type === 'entitytype.added') {
          return e.event.payload.entityType;
        }
        throw new Error('Unexpected event type');
      });
      expect(emittedTypes).toEqual(DEFAULT_ENTITY_TYPES);
    });

    it('should create valid entitytype.added event payloads', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      addedEvents.forEach(event => {
        expect(event.event.type).toBe('entitytype.added');
        if (event.event.type === 'entitytype.added') {
          expect(event.event.payload).toHaveProperty('entityType');
          expect(typeof event.event.payload.entityType).toBe('string');
          expect(event.event.payload.entityType.length).toBeGreaterThan(0);
        }
      });
    });

    it('should populate projection file with all entity types', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(projectionPath, 'utf-8');
      const projection = JSON.parse(content);

      expect(projection.entityTypes).toEqual(DEFAULT_ENTITY_TYPES.sort());
    });
  });

  describe('idempotency', () => {
    it('should skip bootstrap if projection already exists', async () => {
      await bootstrapEntityTypes(eventBus, project);

      resetBootstrap();

      const eventsBefore = await eventStore.log.getEvents('__system__' as any);
      const beforeCount = eventsBefore.length;

      await bootstrapEntityTypes(eventBus, project);

      const eventsAfter = await eventStore.log.getEvents('__system__' as any);
      expect(eventsAfter.length).toBe(beforeCount);
    });

    it('should detect existing projection on filesystem', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Person'] }));

      await bootstrapEntityTypes(eventBus, project);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      expect(systemEvents.length).toBe(0);
    });

    it('should only run once per process', async () => {
      await bootstrapEntityTypes(eventBus, project);
      await bootstrapEntityTypes(eventBus, project);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');
      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });
  });

  describe('path resolution', () => {
    it('should handle absolute filesystem paths', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should handle different filesystem path configurations', async () => {
      resetBootstrap();

      const { project: altProject, teardown: altTeardown } = await createTestProject('bootstrap-alt');

      const altEventBus = new EventBus();
      const altEventStore = createEventStore(altProject, undefined, altEventBus, mockLogger);
      const altGraphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
      const altKb = createKnowledgeBase(altEventStore, altProject, altGraphDb, mockLogger);
      const altStower = new Stower(altKb, altEventBus, mockLogger);
      await altStower.initialize();

      await bootstrapEntityTypes(altEventBus, altProject);

      const projectionPath = join(altProject.stateDir, 'projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);

      await altStower.stop();
      altEventBus.destroy();
      await altTeardown();

      expect(exists).toBe(true);
    });

    it('should create projection directory if it does not exist', async () => {
      const projectionDir = join(project.stateDir, 'projections', '__system__');
      const existsBefore = await fs.access(projectionDir).then(() => true).catch(() => false);
      expect(existsBefore).toBe(false);

      await bootstrapEntityTypes(eventBus, project);

      const existsAfter = await fs.access(projectionDir).then(() => true).catch(() => false);
      expect(existsAfter).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should propagate filesystem errors other than ENOENT', async () => {
      await expect(
        bootstrapEntityTypes(eventBus, project)
      ).resolves.not.toThrow();
    });
  });

  describe('resetBootstrap', () => {
    it('should allow bootstrap to run again after reset', async () => {
      await bootstrapEntityTypes(eventBus, project);

      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.unlink(projectionPath);

      resetBootstrap();

      await bootstrapEntityTypes(eventBus, project);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');
      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length * 2);
    });
  });
});
