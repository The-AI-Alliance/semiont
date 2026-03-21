/**
 * EventStore Factory Tests
 * Tests for createEventStore factory function
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEventStore } from '../event-store-factory';
import { SemiontProject } from '@semiont/core/node';
import type { Logger } from '@semiont/core';
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

describe('createEventStore', () => {
  let testDir: string;
  let project: SemiontProject;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-test-factory-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir, 'test');
  });

  afterEach(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Factory function', () => {
    it('should create EventStore with valid config', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore).toBeDefined();
      expect(eventStore.log).toBeDefined();
      expect(eventStore.bus).toBeDefined();
      expect(eventStore.views).toBeDefined();
    });

    it('should create EventStore with default sharding enabled', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should create EventStore with sharding disabled', () => {
      const eventStore = createEventStore(project, {
        enableSharding: false,
      }, undefined, mockLogger);

      expect(eventStore).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should create EventStore with custom maxEventsPerFile', () => {
      const eventStore = createEventStore(project, {
        maxEventsPerFile: 5000,
      }, undefined, mockLogger);

      expect(eventStore).toBeDefined();
    });

    it('should initialize view storage', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore.views.materializer).toBeDefined();
    });
  });

  describe('Component initialization', () => {
    it('should initialize EventLog with correct config', () => {
      const eventStore = createEventStore(project, {
        enableSharding: true,
        maxEventsPerFile: 1000,
      }, undefined, mockLogger);

      expect(eventStore.log).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should initialize EventBus', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore.bus).toBeDefined();
      expect(eventStore.bus.subscriptions).toBeDefined();
    });

    it('should initialize ViewManager with storage and config', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore.views).toBeDefined();
      expect(eventStore.views.materializer).toBeDefined();
    });

    it('should share EventSubscriptions singleton across EventBus instances', () => {
      const eventStore1 = createEventStore(project, undefined, undefined, mockLogger);
      const eventStore2 = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore1.bus.subscriptions).toBe(eventStore2.bus.subscriptions);
    });
  });

  describe('Storage paths', () => {
    it('should configure event storage', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore.log).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
    });

    it('should set up view storage', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore.views).toBeDefined();
    });
  });

  describe('Integration', () => {
    it('should create fully functional EventStore', () => {
      const eventStore = createEventStore(project, undefined, undefined, mockLogger);

      expect(eventStore.log).toBeDefined();
      expect(eventStore.bus).toBeDefined();
      expect(eventStore.views).toBeDefined();
      expect(eventStore.log.storage).toBeDefined();
      expect(eventStore.views.materializer).toBeDefined();
    });
  });
});
