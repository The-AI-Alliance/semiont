/**
 * Reference Detection Worker Full Lifecycle Tests
 *
 * Tests the complete worker lifecycle including:
 * - Job execution (process detection job end-to-end)
 * - Result structure (totalFound, totalEmitted, errors)
 * - Error handling (resource not found, invalid job type/status)
 * - Content processing (text/plain, text/markdown, non-text content)
 * - emitCompletionEvent (job.completed event with result)
 *
 * Complements reference-detection-worker-events.test.ts which tests event emission in detail.
 * This file focuses on the worker lifecycle and integration testing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ReferenceAnnotationWorker } from '../../jobs/reference-annotation-worker';
import { JobQueue, type RunningJob, type DetectionParams, type DetectionProgress } from '@semiont/jobs';
import { resourceId, userId, type EnvironmentConfig, EventBus, type Logger } from '@semiont/core';
import { jobId, entityType } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference to avoid external API calls
let mockInferenceClient: any;

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  const client = new MockInferenceClient(['[]']);

  return {
    getInferenceClient: vi.fn().mockResolvedValue(client),
    MockInferenceClient
  };
});

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('ReferenceAnnotationWorker - Full Lifecycle', () => {
  let worker: ReferenceAnnotationWorker;
  let testDir: string;
  let eventStore: EventStore;
  let jobQueue: JobQueue;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Initialize mock client
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['[]']);
  });

  beforeEach(async () => {
    // Create temporary test directory for each test
    testDir = join(tmpdir(), `semiont-test-ref-worker-${Date.now()}`);
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

    // Initialize job queue and event store
    jobQueue = new JobQueue({ dataDir: testDir }, mockLogger, new EventBus());
    await jobQueue.initialize();
    eventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);
    const eventBus = new EventBus();
    worker = new ReferenceAnnotationWorker(jobQueue, config, eventStore, mockInferenceClient, eventBus, mockLogger);

    // Set default mock response (empty array - no entities found)
    mockInferenceClient.setResponses(['[]']);
  });

  afterAll(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string, content: string, mediaType: string = 'text/plain'): Promise<void> {
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir, mockLogger);

    const testContent = Buffer.from(content, 'utf-8');
    const { checksum } = await repStore.store(testContent, { mediaType });

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId(id),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: `Test Resource ${id}`,
        format: mediaType,
        contentChecksum: checksum,
        creationMethod: 'api'
      }
    });
  }

  describe('executeJob - job execution', () => {
    it('should process detection job and return result with correct structure', async () => {
      const testResourceId = `resource-execute-${Date.now()}`;
      await createTestResource(testResourceId, 'Test content for execution');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-execute-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalFound');
      expect(result).toHaveProperty('totalEmitted');
      expect(result).toHaveProperty('errors');
      expect(typeof result.totalFound).toBe('number');
      expect(typeof result.totalEmitted).toBe('number');
      expect(typeof result.errors).toBe('number');
    });

    it('should process multiple entity types sequentially', async () => {
      const testResourceId = `resource-multi-${Date.now()}`;
      await createTestResource(testResourceId, 'Test content with multiple types');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-multi-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person'), entityType('Organization'), entityType('Location')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 3,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);

      // With mocked empty responses, should complete successfully with 0 found
      expect(result.totalFound).toBe(0);
      expect(result.totalEmitted).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should complete job with result when no entities found', async () => {
      const testResourceId = `resource-none-${Date.now()}`;
      await createTestResource(testResourceId, 'Content with no entities');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-none-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);

      expect(result.totalFound).toBe(0);
      expect(result.totalEmitted).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should throw when resource not found', async () => {
      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-notfound-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('nonexistent-resource'),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      await expect((worker as any).executeJob(job)).rejects.toThrow('Resource nonexistent-resource not found');
    });

    it('should throw on invalid job type', async () => {
      const job = {
        status: 'running',
        metadata: {
          id: jobId('job-invalid-1'),
          type: 'invalid-type',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {},
        startedAt: new Date().toISOString(),
        progress: {}
      };

      await expect((worker as any).executeJob(job)).rejects.toThrow('Invalid job type');
    });

    it('should throw on invalid job status', async () => {
      const job = {
        status: 'pending',
        metadata: {
          id: jobId('job-invalid-status-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('test-resource'),
          entityTypes: [entityType('Person')]
        },
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      await expect((worker as any).executeJob(job)).rejects.toThrow('Job must be in running state');
    });
  });

  describe('content processing', () => {
    it('should process text/plain content', async () => {
      const testResourceId = `resource-plain-${Date.now()}`;
      await createTestResource(testResourceId, 'Plain text content', 'text/plain');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-plain-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);

      // Should complete successfully
      expect(result).toBeDefined();
      expect(result.totalFound).toBeGreaterThanOrEqual(0);
    });

    it('should process text/markdown content', async () => {
      const testResourceId = `resource-markdown-${Date.now()}`;
      await createTestResource(testResourceId, '# Markdown\n\nContent here', 'text/markdown');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-markdown-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);

      // Should complete successfully
      expect(result).toBeDefined();
      expect(result.totalFound).toBeGreaterThanOrEqual(0);
    });

    it('should handle charset in media type', async () => {
      const testResourceId = `resource-charset-${Date.now()}`;
      await createTestResource(testResourceId, 'Content with charset', 'text/plain; charset=utf-8');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-charset-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);

      // Should process content successfully (charset parameter is stripped)
      expect(result).toBeDefined();
      expect(result.totalFound).toBeGreaterThanOrEqual(0);
    });

    it('should skip non-text content types', async () => {
      const testResourceId = `resource-binary-${Date.now()}`;
      await createTestResource(testResourceId, 'Binary content', 'application/pdf');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-binary-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);

      // Should return empty result for non-text content
      expect(result.totalFound).toBe(0);
      expect(result.totalEmitted).toBe(0);
    });
  });

  describe('emitCompletionEvent', () => {
    it('should emit job.completed event with result', async () => {
      const testResourceId = `resource-completion-${Date.now()}`;
      await createTestResource(testResourceId, 'Test content');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-completion-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = { totalFound: 5, totalEmitted: 5, errors: 0 };

      await (worker as any).emitCompletionEvent(job, result);

      const events = await eventStore.log.getEvents(resourceId(testResourceId));
      const completedEvents = events.filter(e => e.event.type === 'job.completed');

      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0]!.event.payload).toMatchObject({
        jobId: 'job-completion-1',
        jobType: 'reference-annotation',
        result: {
          totalFound: 5,
          totalEmitted: 5,
          errors: 0
        }
      });
    });

    it('should include all result fields in completion event', async () => {
      const testResourceId = `resource-result-fields-${Date.now()}`;
      await createTestResource(testResourceId, 'Test content');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-result-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = { totalFound: 10, totalEmitted: 8, errors: 2 };

      await (worker as any).emitCompletionEvent(job, result);

      const events = await eventStore.log.getEvents(resourceId(testResourceId));
      const completedEvent = events.find(e => e.event.type === 'job.completed');

      expect(completedEvent).toBeDefined();
      if (completedEvent!.event.type === 'job.completed') {
        expect(completedEvent!.event.payload.result).toBeDefined();
        expect(completedEvent!.event.payload.result.totalFound).toBe(10);
        expect(completedEvent!.event.payload.result.totalEmitted).toBe(8);
        expect(completedEvent!.event.payload.result.errors).toBe(2);
      }
    });
  });

  describe('integration', () => {
    it('should complete full detection workflow end-to-end', async () => {
      const testResourceId = `resource-integration-${Date.now()}`;
      await createTestResource(testResourceId, 'Integration test content');

      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-integration-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId(testResourceId),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const result = await (worker as any).executeJob(job);
      await (worker as any).emitCompletionEvent(job, result);

      // Verify result structure
      expect(result).toHaveProperty('totalFound');
      expect(result).toHaveProperty('totalEmitted');
      expect(result).toHaveProperty('errors');

      // Verify completion event was emitted
      const events = await eventStore.log.getEvents(resourceId(testResourceId));
      const completedEvents = events.filter(e => e.event.type === 'job.completed');
      expect(completedEvents.length).toBe(1);
      if (completedEvents[0]!.event.type === 'job.completed') {
        expect(completedEvents[0]!.event.payload.result).toEqual(result);
      }
    });

    it('should handle worker methods via canProcessJob', async () => {
      const detectionJob = {
        status: 'pending' as const,
        metadata: {
          id: jobId('test-1'),
          type: 'reference-annotation' as const,
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('test'),
          entityTypes: [entityType('Person')]
        },
        progress: {
          totalEntityTypes: 1,
          processedEntityTypes: 0,
          entitiesFound: 0,
          entitiesEmitted: 0
        }
      };

      const otherJob = {
        status: 'pending' as const,
        metadata: {
          id: jobId('test-2'),
          type: 'other-type' as any,
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {},
        progress: {}
      };

      expect((worker as any).canProcessJob(detectionJob)).toBe(true);
      expect((worker as any).canProcessJob(otherJob)).toBe(false);
    });

    it('should return correct worker name', async () => {
      expect((worker as any).getWorkerName()).toBe('ReferenceAnnotationWorker');
    });
  });
});
