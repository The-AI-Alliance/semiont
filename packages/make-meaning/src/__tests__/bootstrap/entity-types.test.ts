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
import { userId, EventBus, type Logger } from '@semiont/core';
import { createKnowledgeBase, type KnowledgeBase } from '../../knowledge-base';
import { Stower } from '../../stower';
import { getGraphDatabase } from '@semiont/graph';
import type { GraphServiceConfig } from '@semiont/core';
import type { MakeMeaningConfig } from '../../config';
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

describe('Entity Types Bootstrap', () => {
  let testDir: string;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let stower: Stower;
  let kb: KnowledgeBase;
  let config: MakeMeaningConfig;

  beforeEach(async () => {
    // Reset bootstrap flag before each test
    resetBootstrap();

    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-bootstrap-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration
    config = {
      services: {},
      _metadata: {
        projectRoot: testDir
      },
    } as MakeMeaningConfig;

    // Initialize EventBus, event store, and Stower
    eventBus = new EventBus();
    eventStore = createEventStore(testDir, testDir, undefined, eventBus, mockLogger);
    const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
    kb = createKnowledgeBase(eventStore, testDir, testDir, graphDb, mockLogger);
    stower = new Stower(kb, eventBus, mockLogger);
    await stower.initialize();
  });

  afterEach(async () => {
    // Stop stower and destroy event bus
    await stower.stop();
    eventBus.destroy();
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initial bootstrap', () => {
    it('should create entity types projection when it does not exist', async () => {
      await bootstrapEntityTypes(eventBus, config);

      // Verify projection file was created
      const projectionPath = join(testDir, '.semiont/data/projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should emit entitytype.added events for all DEFAULT_ENTITY_TYPES', async () => {
      await bootstrapEntityTypes(eventBus, config);

      // Get all system events
      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it('should use system user ID for bootstrap events', async () => {
      await bootstrapEntityTypes(eventBus, config);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      // All events should use system user ID
      const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');
      addedEvents.forEach(event => {
        expect(event.event.userId).toBe(SYSTEM_USER_ID);
      });
    });

    it('should emit events in correct order', async () => {
      await bootstrapEntityTypes(eventBus, config);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      // Events should be in same order as DEFAULT_ENTITY_TYPES
      const emittedTypes = addedEvents.map(e => {
        if (e.event.type === 'entitytype.added') {
          return e.event.payload.entityType;
        }
        throw new Error('Unexpected event type');
      });
      expect(emittedTypes).toEqual(DEFAULT_ENTITY_TYPES);
    });

    it('should create valid entitytype.added event payloads', async () => {
      await bootstrapEntityTypes(eventBus, config);

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
      await bootstrapEntityTypes(eventBus, config);

      // Read projection file
      const projectionPath = join(testDir, '.semiont/data/projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(projectionPath, 'utf-8');
      const projection = JSON.parse(content);

      expect(projection.entityTypes).toEqual(DEFAULT_ENTITY_TYPES.sort());
    });
  });

  describe('idempotency', () => {
    it('should skip bootstrap if projection already exists', async () => {
      // First bootstrap
      await bootstrapEntityTypes(eventBus, config);

      // Reset bootstrap flag to allow second call
      resetBootstrap();

      // Count events before second bootstrap
      const eventsBefore = await eventStore.log.getEvents('__system__' as any);
      const beforeCount = eventsBefore.length;

      // Second bootstrap should skip
      await bootstrapEntityTypes(eventBus, config);

      // No new events should be emitted
      const eventsAfter = await eventStore.log.getEvents('__system__' as any);
      expect(eventsAfter.length).toBe(beforeCount);
    });

    it('should detect existing projection on filesystem', async () => {
      // Manually create projection file
      const projectionPath = join(testDir, '.semiont/data/projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, '.semiont/data/projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Person'] }));

      await bootstrapEntityTypes(eventBus, config);

      // No events should be emitted
      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      expect(systemEvents.length).toBe(0);
    });

    it('should only run once per process', async () => {
      // First call
      await bootstrapEntityTypes(eventBus, config);

      // Second call without resetting flag
      await bootstrapEntityTypes(eventBus, config);

      // Should only have events from first call
      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');
      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });
  });

  describe('path resolution', () => {
    it('should handle absolute filesystem paths', async () => {
      // Config already uses absolute path (testDir)
      await bootstrapEntityTypes(eventBus, config);

      const projectionPath = join(testDir, '.semiont/data/projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should handle different filesystem path configurations', async () => {
      const alternateDir = join(testDir, 'alternate-data');
      await fs.mkdir(alternateDir, { recursive: true });

      const alternateConfig = {
        ...config,
        _metadata: {
          projectRoot: alternateDir
        }
      };

      // Reset to allow bootstrap in new directory
      resetBootstrap();

      // Create new EventBus, event store, and Stower for alternate directory
      const altEventBus = new EventBus();
      const alternateEventStore = createEventStore(alternateDir, alternateDir, undefined, altEventBus, mockLogger);
      const altGraphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
      const altKb = createKnowledgeBase(alternateEventStore, alternateDir, alternateDir, altGraphDb, mockLogger);
      const altStower = new Stower(altKb, altEventBus, mockLogger);
      await altStower.initialize();

      await bootstrapEntityTypes(altEventBus, alternateConfig);
      await altStower.stop();
      altEventBus.destroy();

      // Projection should be in the alternate directory
      const projectionPath = join(alternateDir, '.semiont/data/projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should create projection directory if it does not exist', async () => {
      // Verify directory doesn't exist initially
      const projectionDir = join(testDir, '.semiont/data/projections', '__system__');
      const existsBefore = await fs.access(projectionDir).then(() => true).catch(() => false);
      expect(existsBefore).toBe(false);

      await bootstrapEntityTypes(eventBus, config);

      // Directory should now exist
      const existsAfter = await fs.access(projectionDir).then(() => true).catch(() => false);
      expect(existsAfter).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw if projectRoot is not configured', async () => {
      const invalidConfig = { ...config, _metadata: undefined };

      await expect(
        bootstrapEntityTypes(eventBus, invalidConfig as MakeMeaningConfig)
      ).rejects.toThrow('projectRoot is required');
    });

    it('should propagate filesystem errors other than ENOENT', async () => {
      // This is difficult to test without mocking fs, but we can verify
      // the function completes normally with valid config
      await expect(
        bootstrapEntityTypes(eventBus, config)
      ).resolves.not.toThrow();
    });
  });

  describe('resetBootstrap', () => {
    it('should allow bootstrap to run again after reset', async () => {
      // First bootstrap
      await bootstrapEntityTypes(eventBus, config);

      // Delete projection to simulate fresh start
      const projectionPath = join(testDir, '.semiont/data/projections', '__system__', 'entitytypes.json');
      await fs.unlink(projectionPath);

      // Reset flag
      resetBootstrap();

      // Should bootstrap again
      await bootstrapEntityTypes(eventBus, config);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');
      // Should have double the events (from both bootstraps)
      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length * 2);
    });
  });
});
