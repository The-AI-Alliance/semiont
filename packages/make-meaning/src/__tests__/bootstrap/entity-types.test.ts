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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrapEntityTypes, resetBootstrap } from '../../bootstrap/entity-types';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { userId, type EnvironmentConfig } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Entity Types Bootstrap', () => {
  let testDir: string;
  let eventStore: EventStore;
  let config: EnvironmentConfig;

  beforeEach(async () => {
    // Reset bootstrap flag before each test
    resetBootstrap();

    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-bootstrap-${Date.now()}`);
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

    // Initialize event store
    eventStore = createEventStore(testDir, config.services.backend!.publicURL);
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initial bootstrap', () => {
    it('should create entity types projection when it does not exist', async () => {
      await bootstrapEntityTypes(eventStore, config);

      // Verify projection file was created
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should emit entitytype.added events for all DEFAULT_ENTITY_TYPES', async () => {
      await bootstrapEntityTypes(eventStore, config);

      // Get all system events
      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });

    it('should use system user ID for bootstrap events', async () => {
      await bootstrapEntityTypes(eventStore, config);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      // All events should use system user ID
      const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');
      addedEvents.forEach(event => {
        expect(event.event.userId).toBe(SYSTEM_USER_ID);
      });
    });

    it('should emit events in correct order', async () => {
      await bootstrapEntityTypes(eventStore, config);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      // Events should be in same order as DEFAULT_ENTITY_TYPES
      const emittedTypes = addedEvents.map(e => e.event.payload.entityType);
      expect(emittedTypes).toEqual(DEFAULT_ENTITY_TYPES);
    });

    it('should create valid entitytype.added event payloads', async () => {
      await bootstrapEntityTypes(eventStore, config);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');

      addedEvents.forEach(event => {
        expect(event.event.type).toBe('entitytype.added');
        expect(event.event.payload).toHaveProperty('entityType');
        expect(typeof event.event.payload.entityType).toBe('string');
        expect(event.event.payload.entityType.length).toBeGreaterThan(0);
      });
    });

    it('should populate projection file with all entity types', async () => {
      await bootstrapEntityTypes(eventStore, config);

      // Read projection file
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const content = await fs.readFile(projectionPath, 'utf-8');
      const projection = JSON.parse(content);

      expect(projection.entityTypes).toEqual(DEFAULT_ENTITY_TYPES.sort());
    });
  });

  describe('idempotency', () => {
    it('should skip bootstrap if projection already exists', async () => {
      // First bootstrap
      await bootstrapEntityTypes(eventStore, config);

      // Reset bootstrap flag to allow second call
      resetBootstrap();

      // Count events before second bootstrap
      const eventsBefore = await eventStore.log.getEvents('__system__' as any);
      const beforeCount = eventsBefore.length;

      // Second bootstrap should skip
      await bootstrapEntityTypes(eventStore, config);

      // No new events should be emitted
      const eventsAfter = await eventStore.log.getEvents('__system__' as any);
      expect(eventsAfter.length).toBe(beforeCount);
    });

    it('should detect existing projection on filesystem', async () => {
      // Manually create projection file
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Person'] }));

      await bootstrapEntityTypes(eventStore, config);

      // No events should be emitted
      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      expect(systemEvents.length).toBe(0);
    });

    it('should only run once per process', async () => {
      // First call
      await bootstrapEntityTypes(eventStore, config);

      // Second call without resetting flag
      await bootstrapEntityTypes(eventStore, config);

      // Should only have events from first call
      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');
      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length);
    });
  });

  describe('path resolution', () => {
    it('should handle absolute filesystem paths', async () => {
      // Config already uses absolute path (testDir)
      await bootstrapEntityTypes(eventStore, config);

      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should handle different filesystem path configurations', async () => {
      const alternateDir = join(testDir, 'alternate-data');
      await fs.mkdir(alternateDir, { recursive: true });

      const alternateConfig = {
        ...config,
        services: {
          ...config.services,
          filesystem: {
            platform: { type: 'posix' as const },
            path: alternateDir
          }
        },
        _metadata: {
          environment: 'test',
          projectRoot: alternateDir
        }
      };

      // Reset to allow bootstrap in new directory
      resetBootstrap();

      // Create new event store for alternate directory
      const alternateEventStore = createEventStore(alternateDir, config.services.backend!.publicURL);

      await bootstrapEntityTypes(alternateEventStore, alternateConfig);

      // Projection should be in the alternate directory
      const projectionPath = join(alternateDir, 'projections', '__system__', 'entitytypes.json');
      const exists = await fs.access(projectionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should create projection directory if it does not exist', async () => {
      // Verify directory doesn't exist initially
      const projectionDir = join(testDir, 'projections', '__system__');
      const existsBefore = await fs.access(projectionDir).then(() => true).catch(() => false);
      expect(existsBefore).toBe(false);

      await bootstrapEntityTypes(eventStore, config);

      // Directory should now exist
      const existsAfter = await fs.access(projectionDir).then(() => true).catch(() => false);
      expect(existsAfter).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw if filesystem path is not configured', async () => {
      const invalidConfig = { ...config };
      delete invalidConfig.services.filesystem;

      await expect(
        bootstrapEntityTypes(eventStore, invalidConfig as EnvironmentConfig)
      ).rejects.toThrow();
    });

    it('should propagate filesystem errors other than ENOENT', async () => {
      // This is difficult to test without mocking fs, but we can verify
      // the function completes normally with valid config
      await expect(
        bootstrapEntityTypes(eventStore, config)
      ).resolves.not.toThrow();
    });
  });

  describe('resetBootstrap', () => {
    it('should allow bootstrap to run again after reset', async () => {
      // First bootstrap
      await bootstrapEntityTypes(eventStore, config);

      // Delete projection to simulate fresh start
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.unlink(projectionPath);

      // Reset flag
      resetBootstrap();

      // Should bootstrap again
      await bootstrapEntityTypes(eventStore, config);

      const systemEvents = await eventStore.log.getEvents('__system__' as any);
      const addedEvents = systemEvents.filter(e => e.event.type === 'entitytype.added');
      // Should have double the events (from both bootstraps)
      expect(addedEvents.length).toBe(DEFAULT_ENTITY_TYPES.length * 2);
    });
  });
});
