/**
 * Make-Meaning Service Tests
 *
 * Tests the service initialization and lifecycle:
 * - Configuration validation
 * - Job queue initialization
 * - EventStore creation
 * - Entity types bootstrapping
 * - RepresentationStore creation
 * - InferenceClient creation
 * - GraphDB connection
 * - GraphDBConsumer initialization
 * - Worker instantiation and startup
 * - Service handle return
 * - Cleanup and stop
 * - Error handling during initialization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startMakeMeaning, type MakeMeaningService } from '../service';
import type { EnvironmentConfig, Logger } from '@semiont/core';
import { EventBus } from '@semiont/core';
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

describe('Make-Meaning Service', () => {
  let testDir: string;
  let config: EnvironmentConfig;
  let service: MakeMeaningService | null = null;
  let eventBus: EventBus;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-service-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create EventBus
    eventBus = new EventBus();

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
  });

  afterEach(async () => {
    // Stop service if it was started
    if (service) {
      await service.stop();
      service = null;
    }

    // Destroy EventBus
    if (eventBus) {
      eventBus.destroy();
    }

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should validate required configuration', async () => {
      const invalidConfig = { ...config };
      delete invalidConfig.services.filesystem;

      await expect(
        startMakeMeaning(invalidConfig as EnvironmentConfig, eventBus, mockLogger)
      ).rejects.toThrow('services.filesystem.path is required');
    });

    it('should require backend publicURL', async () => {
      const invalidConfig = { ...config };
      delete invalidConfig.services.backend;

      await expect(
        startMakeMeaning(invalidConfig as EnvironmentConfig, eventBus, mockLogger)
      ).rejects.toThrow('services.backend.publicURL is required');
    });

    it('should initialize job queue', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service.jobQueue).toBeDefined();
      expect(typeof service.jobQueue.createJob).toBe('function');
      expect(typeof service.jobQueue.getJob).toBe('function');
    });

    it('should create event store', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service.eventStore).toBeDefined();
      expect(typeof service.eventStore.appendEvent).toBe('function');
      expect(service.eventStore.log).toBeDefined();
      expect(service.eventStore.bus).toBeDefined();
      expect(service.eventStore.views).toBeDefined();
    });

    it('should create representation store', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service.repStore).toBeDefined();
      expect(typeof service.repStore.store).toBe('function');
      expect(typeof service.repStore.retrieve).toBe('function');
    });

    it('should create inference client', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service.inferenceClient).toBeDefined();
      expect(typeof service.inferenceClient.generateText).toBe('function');
    });

    it('should connect to graph database', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service.graphDb).toBeDefined();
      expect(typeof service.graphDb.disconnect).toBe('function');
    });

    it('should initialize graph consumer', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service.graphConsumer).toBeDefined();
      expect(typeof service.graphConsumer.stop).toBe('function');
    });

    it('should instantiate all workers', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service.workers).toBeDefined();
      expect(service.workers.detection).toBeDefined();
      expect(service.workers.generation).toBeDefined();
      expect(service.workers.highlight).toBeDefined();
      expect(service.workers.assessment).toBeDefined();
      expect(service.workers.comment).toBeDefined();
      expect(service.workers.tag).toBeDefined();

      // Verify workers have start/stop methods
      expect(typeof service.workers.detection.start).toBe('function');
      expect(typeof service.workers.detection.stop).toBe('function');
    });

    it('should return service handle with stop method', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      expect(service).toBeDefined();
      expect(typeof service.stop).toBe('function');
    });

    it('should handle relative filesystem paths', async () => {
      const relativeConfig = {
        ...config,
        services: {
          ...config.services,
          filesystem: {
            platform: { type: 'posix' as const },
            path: './relative-test-path'
          }
        }
      };

      service = await startMakeMeaning(relativeConfig, eventBus, mockLogger);
      expect(service).toBeDefined();
    });

    it('should handle absolute filesystem paths', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);
      expect(service).toBeDefined();
    });
  });

  describe('lifecycle', () => {
    it('should start and stop cleanly', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);
      expect(service).toBeDefined();

      // Should not throw
      await expect(service.stop()).resolves.not.toThrow();

      // Clear service reference since we stopped it
      service = null;
    });

    it('should stop all workers on service stop', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      // Spy on worker stop methods
      const detectionStopSpy = vi.spyOn(service.workers.detection, 'stop');
      const generationStopSpy = vi.spyOn(service.workers.generation, 'stop');
      const highlightStopSpy = vi.spyOn(service.workers.highlight, 'stop');
      const assessmentStopSpy = vi.spyOn(service.workers.assessment, 'stop');
      const commentStopSpy = vi.spyOn(service.workers.comment, 'stop');
      const tagStopSpy = vi.spyOn(service.workers.tag, 'stop');

      await service.stop();

      expect(detectionStopSpy).toHaveBeenCalled();
      expect(generationStopSpy).toHaveBeenCalled();
      expect(highlightStopSpy).toHaveBeenCalled();
      expect(assessmentStopSpy).toHaveBeenCalled();
      expect(commentStopSpy).toHaveBeenCalled();
      expect(tagStopSpy).toHaveBeenCalled();

      service = null;
    });

    it('should stop graph consumer on service stop', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      const consumerStopSpy = vi.spyOn(service.graphConsumer, 'stop');

      await service.stop();

      expect(consumerStopSpy).toHaveBeenCalled();

      service = null;
    });

    it('should disconnect graph database on service stop', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      const dbDisconnectSpy = vi.spyOn(service.graphDb, 'disconnect');

      await service.stop();

      expect(dbDisconnectSpy).toHaveBeenCalled();

      service = null;
    });
  });

  describe('integration', () => {
    it('should complete initialization without errors', async () => {
      // Service initialization includes bootstrap step
      service = await startMakeMeaning(config, eventBus, mockLogger);

      // If we got here, bootstrap completed successfully
      expect(service).toBeDefined();
      expect(service.eventStore).toBeDefined();
      expect(service.graphDb).toBeDefined();
      expect(service.graphConsumer).toBeDefined();
    });

    it('should allow multiple service instances with different directories', async () => {
      const testDir2 = join(tmpdir(), `semiont-test-service-2-${Date.now()}`);
      await fs.mkdir(testDir2, { recursive: true });

      const config2 = {
        ...config,
        services: {
          ...config.services,
          filesystem: {
            platform: { type: 'posix' as const },
            path: testDir2
          }
        },
        _metadata: {
          environment: 'test',
          projectRoot: testDir2
        }
      };

      const eventBus2 = new EventBus();

      const service1 = await startMakeMeaning(config, eventBus, mockLogger);
      const service2 = await startMakeMeaning(config2, eventBus2, mockLogger);

      expect(service1).toBeDefined();
      expect(service2).toBeDefined();
      expect(service1.jobQueue).not.toBe(service2.jobQueue);

      await service1.stop();
      await service2.stop();
      eventBus2.destroy();
      await fs.rm(testDir2, { recursive: true, force: true });

      // Clear service reference since we stopped it
      service = null;
    });

    it('should share event store and inference client across workers', async () => {
      service = await startMakeMeaning(config, eventBus, mockLogger);

      // All workers should share the same eventStore instance
      const eventStoreRefs = [
        service.workers.detection,
        service.workers.generation,
        service.workers.highlight,
        service.workers.assessment,
        service.workers.comment,
        service.workers.tag,
      ].map(w => (w as any).eventStore);

      // All should be the same instance
      eventStoreRefs.forEach(ref => {
        expect(ref).toBe(service!.eventStore);
      });

      // All workers should share the same inference client
      const inferenceClientRefs = [
        service.workers.detection,
        service.workers.generation,
        service.workers.highlight,
        service.workers.assessment,
        service.workers.comment,
        service.workers.tag,
      ].map(w => (w as any).inferenceClient);

      // All should be the same instance
      inferenceClientRefs.forEach(ref => {
        expect(ref).toBe(service!.inferenceClient);
      });
    });
  });
});
