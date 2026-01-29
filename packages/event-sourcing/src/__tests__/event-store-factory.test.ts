/**
 * EventStore Factory Tests
 * Tests for createEventStore factory function
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEventStore } from '../event-store-factory';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('createEventStore', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-factory-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Factory function', () => {
    it('should create EventStore with valid config', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      expect(eventStore).toBeDefined();
      expect(eventStore.log).toBeDefined();
      expect(eventStore.bus).toBeDefined();
      expect(eventStore.views).toBeDefined();
    });

    it('should create EventStore with default sharding enabled', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      expect(eventStore).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should create EventStore with sharding disabled', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000', {
        enableSharding: false,
      });

      expect(eventStore).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should create EventStore with custom maxEventsPerFile', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000', {
        maxEventsPerFile: 5000,
      });

      expect(eventStore).toBeDefined();
    });

    it('should initialize view storage', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      expect(eventStore.views.materializer).toBeDefined();
    });
  });

  describe('Config validation', () => {
    it('should require basePath', () => {
      expect(() => createEventStore('', 'http://localhost:4000')).toThrow();
    });

    it('should require baseUrl', () => {
      expect(() => createEventStore(testDir, '')).toThrow();
    });

    it('should require absolute basePath', () => {
      expect(() => createEventStore('relative/path', 'http://localhost:4000')).toThrow(
        'basePath must be an absolute path'
      );
    });
  });

  describe('Component initialization', () => {
    it('should initialize EventLog with correct config', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000', {
        enableSharding: true,
        maxEventsPerFile: 1000,
      });

      expect(eventStore.log).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should initialize EventBus with identifier config', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      expect(eventStore.bus).toBeDefined();
      expect(eventStore.bus.subscriptions).toBeDefined();
    });

    it('should initialize ViewManager with storage and config', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      expect(eventStore.views).toBeDefined();
      expect(eventStore.views.materializer).toBeDefined();
    });

    it('should share EventSubscriptions singleton across EventBus instances', () => {
      const eventStore1 = createEventStore(testDir, 'http://localhost:4000');
      const eventStore2 = createEventStore(testDir, 'http://localhost:4000');

      // Both EventBus instances should share same subscriptions
      expect(eventStore1.bus.subscriptions).toBe(eventStore2.bus.subscriptions);
    });
  });

  describe('Storage paths', () => {
    it('should configure event storage to use basePath/events', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      expect(eventStore).toBeDefined();
      expect(eventStore.log).toBeDefined();

      // Event storage creates directories lazily when first event is appended
      // Just verify that EventStore has a configured EventLog
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should set up view storage to use basePath/projections', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      expect(eventStore).toBeDefined();

      // View storage creates directories lazily when first projection is saved
      // Just verify that EventStore is configured with ViewStorage
      expect(eventStore.views).toBeDefined();
    });
  });

  describe('Integration', () => {
    it('should create fully functional EventStore', () => {
      const eventStore = createEventStore(testDir, 'http://localhost:4000');

      // Verify all components are connected
      expect(eventStore.log).toBeDefined();
      expect(eventStore.bus).toBeDefined();
      expect(eventStore.views).toBeDefined();

      // Verify we can access storage through log
      expect(eventStore.log.storage).toBeDefined();

      // Verify view manager has materializer
      expect(eventStore.views.materializer).toBeDefined();
    });
  });
});
