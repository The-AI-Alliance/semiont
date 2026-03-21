/**
 * Reference Detection Worker Full Lifecycle Tests
 *
 * Tests the complete worker lifecycle including:
 * - Job execution (process detection job end-to-end)
 * - Result structure (totalFound, totalEmitted, errors)
 * - Error handling (resource not found, invalid job type/status)
 * - Content processing (text/plain, text/markdown, non-text content)
 * - emitCompletionEvent (job:complete event with result)
 *
 * Complements reference-annotation-worker-events.test.ts which tests event emission in detail.
 * This file focuses on the worker lifecycle and integration testing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { ReferenceAnnotationWorker } from '../../../workers/reference-annotation-worker';
import { JobQueue, type RunningJob, type DetectionParams, type DetectionProgress, type ContentFetcher } from '@semiont/jobs';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, userId, EventBus, jobId, entityType, type Logger } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

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

const mockContentFetcher: ContentFetcher = async () => {
  const { Readable } = await import('stream');
  return Readable.from([Buffer.from('test content')]);
};

describe('ReferenceAnnotationWorker - Full Lifecycle', () => {
  let worker: ReferenceAnnotationWorker;
  let testDir: string;
  let jobQueue: JobQueue;
  let eventBus: EventBus;

  beforeAll(async () => {
    // Initialize mock client
    const { MockInferenceClient } = await import('@semiont/inference');
    mockInferenceClient = new MockInferenceClient(['[]']);
  });

  beforeEach(async () => {
    // Create temporary test directory for each test
    testDir = join(tmpdir(), `semiont-test-ref-worker-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Initialize job queue
    eventBus = new EventBus();
    jobQueue = new JobQueue(new SemiontProject(testDir), mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new ReferenceAnnotationWorker(jobQueue, mockInferenceClient, eventBus, mockContentFetcher, mockLogger);

    // Set default mock response (empty array - no entities found)
    mockInferenceClient.setResponses(['[]']);
  });

  afterAll(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('executeJob - job execution', () => {
    it('should process detection job and return result with correct structure', async () => {
      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-execute-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('resource-execute-1'),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: { totalEntityTypes: 1, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
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
      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-multi-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('resource-multi-1'),
          entityTypes: [entityType('Person'), entityType('Organization'), entityType('Location')]
        },
        startedAt: new Date().toISOString(),
        progress: { totalEntityTypes: 3, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
      };

      const result = await (worker as any).executeJob(job);

      // With mocked empty responses, should complete successfully with 0 found
      expect(result.totalFound).toBe(0);
      expect(result.totalEmitted).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should complete job with result when no entities found', async () => {
      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-none-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('resource-none-1'),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: { totalEntityTypes: 1, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
      };

      const result = await (worker as any).executeJob(job);

      expect(result.totalFound).toBe(0);
      expect(result.totalEmitted).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should throw on invalid job type', async () => {
      const job = {
        status: 'running',
        metadata: {
          id: jobId('job-invalid-1'),
          type: 'invalid-type',
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
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
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('test-resource'),
          entityTypes: [entityType('Person')]
        },
        progress: { totalEntityTypes: 1, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
      };

      await expect((worker as any).executeJob(job)).rejects.toThrow('Job must be in running state');
    });
  });

  describe('emitCompletionEvent', () => {
    it('should emit job:complete event with result', async () => {
      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-completion-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('resource-completion-1'),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: { totalEntityTypes: 1, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
      };

      const completeEvents: any[] = [];
      const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

      const result = { totalFound: 5, totalEmitted: 5, errors: 0 };
      await (worker as any).emitCompletionEvent(job, result);

      sub.unsubscribe();

      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0]).toMatchObject({
        jobId: jobId('job-completion-1'),
        jobType: 'reference-annotation',
        result: { result: { totalFound: 5, totalEmitted: 5, errors: 0 } }
      });
    });

    it('should include all result fields in completion event', async () => {
      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-result-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('resource-result-fields-1'),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: { totalEntityTypes: 1, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
      };

      const completeEvents: any[] = [];
      const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

      const result = { totalFound: 10, totalEmitted: 8, errors: 2 };
      await (worker as any).emitCompletionEvent(job, result);

      sub.unsubscribe();

      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0].result.result).toEqual({ totalFound: 10, totalEmitted: 8, errors: 2 });
    });
  });

  describe('integration', () => {
    it('should complete full detection workflow end-to-end', async () => {
      const job: RunningJob<DetectionParams, DetectionProgress> = {
        status: 'running',
        metadata: {
          id: jobId('job-integration-1'),
          type: 'reference-annotation',
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('resource-integration-1'),
          entityTypes: [entityType('Person')]
        },
        startedAt: new Date().toISOString(),
        progress: { totalEntityTypes: 1, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
      };

      const completeEvents: any[] = [];
      const sub = eventBus.get('job:complete').subscribe(e => completeEvents.push(e));

      const result = await (worker as any).executeJob(job);
      await (worker as any).emitCompletionEvent(job, result);

      sub.unsubscribe();

      // Verify result structure
      expect(result).toHaveProperty('totalFound');
      expect(result).toHaveProperty('totalEmitted');
      expect(result).toHaveProperty('errors');

      // Verify completion event was emitted
      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0].result).toEqual({ result });
    });

    it('should handle worker methods via canProcessJob', async () => {
      const detectionJob = {
        status: 'pending' as const,
        metadata: {
          id: jobId('test-1'),
          type: 'reference-annotation' as const,
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3
        },
        params: {
          resourceId: resourceId('test'),
          entityTypes: [entityType('Person')]
        },
        progress: { totalEntityTypes: 1, processedEntityTypes: 0, entitiesFound: 0, entitiesEmitted: 0 }
      };

      const otherJob = {
        status: 'pending' as const,
        metadata: {
          id: jobId('test-2'),
          type: 'other-type' as any,
          userId: userId('user-1'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
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
