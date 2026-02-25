/**
 * Unit tests for JobQueue class
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JobQueue } from '../job-queue';
import type { JobStatus, PendingJob, RunningJob, CompleteJob, FailedJob, DetectionParams, DetectionProgress, DetectionResult, GenerationParams } from '../types';
import { entityType, jobId, userId, resourceId, annotationId, EventBus } from '@semiont/core';

// Test helper - create detection jobs in various states
function createPendingDetectionJob(id: string): PendingJob<DetectionParams> {
  return {
    status: 'pending',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person'), entityType('Organization')],
    },
  };
}

function createRunningDetectionJob(id: string): RunningJob<DetectionParams, DetectionProgress> {
  return {
    status: 'running',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person'), entityType('Organization')],
    },
    startedAt: new Date().toISOString(),
    progress: {
      totalEntityTypes: 2,
      processedEntityTypes: 1,
      currentEntityType: 'Person',
      entitiesFound: 5,
      entitiesEmitted: 5,
    },
  };
}

function createCompleteDetectionJob(id: string): CompleteJob<DetectionParams, DetectionResult> {
  return {
    status: 'complete',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person'), entityType('Organization')],
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: {
      totalFound: 10,
      totalEmitted: 10,
      errors: 0,
    },
  };
}

function createFailedDetectionJob(id: string): FailedJob<DetectionParams> {
  return {
    status: 'failed',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 1,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: 'Test error',
  };
}

function createPendingGenerationJob(id: string): PendingJob<GenerationParams> {
  return {
    status: 'pending',
    metadata: {
      id: jobId(id),
      type: 'generation',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      referenceId: annotationId('ann-1'),
      sourceResourceId: resourceId('res-1'),
      prompt: 'Generate a summary',
    },
  };
}

describe('JobQueue', () => {
  let tempDir: string;
  let jobQueue: JobQueue;

  beforeEach(async () => {
    // Create a temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-queue-test-'));
    jobQueue = new JobQueue({ dataDir: tempDir }, new EventBus());
    await jobQueue.initialize();
  });

  afterEach(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initialize()', () => {
    test('should create all status directories', async () => {
      const statuses: JobStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];

      for (const status of statuses) {
        const statusDir = path.join(tempDir, 'jobs', status);
        const stats = await fs.stat(statusDir);
        expect(stats.isDirectory()).toBe(true);
      }
    });

    test('should not throw if directories already exist', async () => {
      // Initialize again
      await expect(jobQueue.initialize()).resolves.not.toThrow();
    });
  });

  describe('createJob()', () => {
    test('should create a detection job in pending status', async () => {
      const job = createPendingDetectionJob('job-123');

      await jobQueue.createJob(job);

      const jobPath = path.join(tempDir, 'jobs', 'pending', 'job-123.json');
      const content = await fs.readFile(jobPath, 'utf-8');
      const savedJob = JSON.parse(content);

      expect(savedJob).toEqual(job);
    });

    test('should create a generation job in pending status', async () => {
      const job = createPendingGenerationJob('job-456');

      await jobQueue.createJob(job);

      const jobPath = path.join(tempDir, 'jobs', 'pending', 'job-456.json');
      const exists = await fs.access(jobPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('should create job in correct status directory', async () => {
      const job = createRunningDetectionJob('job-running');

      await jobQueue.createJob(job);

      const jobPath = path.join(tempDir, 'jobs', 'running', 'job-running.json');
      const exists = await fs.access(jobPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('getJob()', () => {
    test('should find job in pending status', async () => {
      const job = createPendingDetectionJob('job-123');
      await jobQueue.createJob(job);

      const retrieved = await jobQueue.getJob(jobId('job-123'));

      expect(retrieved).toEqual(job);
    });

    test('should find job in running status', async () => {
      const job = createRunningDetectionJob('job-123');
      await jobQueue.createJob(job);

      const retrieved = await jobQueue.getJob(jobId('job-123'));

      expect(retrieved).toEqual(job);
    });

    test('should return null for non-existent job', async () => {
      const retrieved = await jobQueue.getJob(jobId('nonexistent'));

      expect(retrieved).toBeNull();
    });
  });

  describe('updateJob()', () => {
    test('should update job in same status', async () => {
      const job = createPendingDetectionJob('job-123');
      await jobQueue.createJob(job);

      // Update metadata
      const updated = { ...job, metadata: { ...job.metadata, retryCount: 1 } };
      await jobQueue.updateJob(updated);

      const retrieved = await jobQueue.getJob(jobId('job-123'));
      expect(retrieved?.metadata.retryCount).toBe(1);
    });

    test('should move job between status directories', async () => {
      const pendingJob = createPendingDetectionJob('job-123');
      await jobQueue.createJob(pendingJob);

      const runningJob = createRunningDetectionJob('job-123');
      await jobQueue.updateJob(runningJob, 'pending');

      // Check old location is gone
      const pendingPath = path.join(tempDir, 'jobs', 'pending', 'job-123.json');
      const pendingExists = await fs.access(pendingPath).then(() => true).catch(() => false);
      expect(pendingExists).toBe(false);

      // Check new location exists
      const runningPath = path.join(tempDir, 'jobs', 'running', 'job-123.json');
      const runningExists = await fs.access(runningPath).then(() => true).catch(() => false);
      expect(runningExists).toBe(true);
    });
  });

  describe('listJobs()', () => {
    test('should list all jobs', async () => {
      const job1 = createPendingDetectionJob('job-1');
      const job2 = createRunningDetectionJob('job-2');
      const job3 = createCompleteDetectionJob('job-3');

      await jobQueue.createJob(job1);
      await jobQueue.createJob(job2);
      await jobQueue.createJob(job3);

      const jobs = await jobQueue.listJobs();

      expect(jobs.length).toBe(3);
      expect(jobs.map(j => j.metadata.id)).toContain(jobId('job-1'));
      expect(jobs.map(j => j.metadata.id)).toContain(jobId('job-2'));
      expect(jobs.map(j => j.metadata.id)).toContain(jobId('job-3'));
    });

    test('should filter by status', async () => {
      const job1 = createPendingDetectionJob('job-1');
      const job2 = createRunningDetectionJob('job-2');

      await jobQueue.createJob(job1);
      await jobQueue.createJob(job2);

      const pendingJobs = await jobQueue.listJobs({ status: 'pending' });

      expect(pendingJobs.length).toBe(1);
      expect(pendingJobs[0]?.metadata.id).toBe(jobId('job-1'));
    });

    test('should filter by type', async () => {
      const detectionJob = createPendingDetectionJob('job-1');
      const generationJob = createPendingGenerationJob('job-2');

      await jobQueue.createJob(detectionJob);
      await jobQueue.createJob(generationJob);

      const detectionJobs = await jobQueue.listJobs({ type: 'reference-annotation' });

      expect(detectionJobs.length).toBe(1);
      expect(detectionJobs[0]?.metadata.id).toBe(jobId('job-1'));
    });

    test('should filter by userId', async () => {
      const job1 = createPendingDetectionJob('job-1');
      const job2 = {
        ...createPendingDetectionJob('job-2'),
        metadata: {
          ...createPendingDetectionJob('job-2').metadata,
          userId: userId('user-2'),
        },
      };

      await jobQueue.createJob(job1);
      await jobQueue.createJob(job2);

      const user1Jobs = await jobQueue.listJobs({ userId: userId('user-1') });

      expect(user1Jobs.length).toBe(1);
      expect(user1Jobs[0]?.metadata.id).toBe(jobId('job-1'));
    });

    test('should apply pagination', async () => {
      const job1 = createPendingDetectionJob('job-1');
      const job2 = createPendingDetectionJob('job-2');
      const job3 = createPendingDetectionJob('job-3');

      await jobQueue.createJob(job1);
      await jobQueue.createJob(job2);
      await jobQueue.createJob(job3);

      const page1 = await jobQueue.listJobs({ limit: 2, offset: 0 });
      const page2 = await jobQueue.listJobs({ limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(1);
    });
  });

  describe('pollNextPendingJob()', () => {
    test('should return oldest pending job', async () => {
      const job1 = createPendingDetectionJob('job-1');
      const job2 = createPendingDetectionJob('job-2');

      await jobQueue.createJob(job1);
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      await jobQueue.createJob(job2);

      const polled = await jobQueue.pollNextPendingJob();

      expect(polled?.metadata.id).toBe(jobId('job-1'));
    });

    test('should return null when no pending jobs', async () => {
      const polled = await jobQueue.pollNextPendingJob();

      expect(polled).toBeNull();
    });
  });

  describe('cancelJob()', () => {
    test('should cancel a pending job', async () => {
      const job = createPendingDetectionJob('job-cancel');
      await jobQueue.createJob(job);

      const result = await jobQueue.cancelJob(jobId('job-cancel'));

      expect(result).toBe(true);

      const retrieved = await jobQueue.getJob(jobId('job-cancel'));
      expect(retrieved?.status).toBe('cancelled');
    });

    test('should cancel a running job', async () => {
      const job = createRunningDetectionJob('job-cancel-running');
      await jobQueue.createJob(job);

      const result = await jobQueue.cancelJob(jobId('job-cancel-running'));

      expect(result).toBe(true);

      const retrieved = await jobQueue.getJob(jobId('job-cancel-running'));
      expect(retrieved?.status).toBe('cancelled');
      if (retrieved?.status === 'cancelled') {
        expect(retrieved.startedAt).toBeDefined();
      }
    });

    test('should not cancel a completed job', async () => {
      const job = createCompleteDetectionJob('job-complete');
      await jobQueue.createJob(job);

      const result = await jobQueue.cancelJob(jobId('job-complete'));

      expect(result).toBe(false);
    });

    test('should return false for non-existent job', async () => {
      const result = await jobQueue.cancelJob(jobId('nonexistent'));

      expect(result).toBe(false);
    });
  });

  describe('cleanupOldJobs()', () => {
    test('should delete completed jobs older than retention period', async () => {
      const oldJob = createCompleteDetectionJob('job-old');
      // Set completedAt to 2 days ago
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      (oldJob as any).completedAt = twoDaysAgo;

      await jobQueue.createJob(oldJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24); // 24 hour retention

      expect(deletedCount).toBe(1);

      const retrieved = await jobQueue.getJob(jobId('job-old'));
      expect(retrieved).toBeNull();
    });

    test('should not delete recent jobs', async () => {
      const recentJob = createCompleteDetectionJob('job-recent');

      await jobQueue.createJob(recentJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24);

      expect(deletedCount).toBe(0);

      const retrieved = await jobQueue.getJob(jobId('job-recent'));
      expect(retrieved).not.toBeNull();
    });
  });

  describe('getStats()', () => {
    test('should return correct counts for each status', async () => {
      const pending1 = createPendingDetectionJob('job-pending-1');
      const pending2 = createPendingDetectionJob('job-pending-2');
      const running = createRunningDetectionJob('job-running');
      const complete = createCompleteDetectionJob('job-complete');
      const failed = createFailedDetectionJob('job-failed');

      await jobQueue.createJob(pending1);
      await jobQueue.createJob(pending2);
      await jobQueue.createJob(running);
      await jobQueue.createJob(complete);
      await jobQueue.createJob(failed);

      const stats = await jobQueue.getStats();

      expect(stats.pending).toBe(2);
      expect(stats.running).toBe(1);
      expect(stats.complete).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.cancelled).toBe(0);
    });
  });

  describe('EventBus Integration', () => {
    test('should emit job:queued event when creating a job', async () => {
      const eventBus = new EventBus();
      const testQueue = new JobQueue({ dataDir: tempDir }, eventBus);
      await testQueue.initialize();

      const events: any[] = [];
      const job = createPendingDetectionJob('job-with-event');
      const resourceBus = eventBus.scope(job.params.resourceId);

      // Subscribe to job:queued events
      resourceBus.get('job:queued').subscribe(event => {
        events.push(event);
      });

      await testQueue.createJob(job);

      // Verify event was emitted
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        jobId: jobId('job-with-event'),
        jobType: 'reference-annotation',
        resourceId: job.params.resourceId
      });
    });

    test('should not fail when EventBus is not provided', async () => {
      const testQueue = new JobQueue({ dataDir: tempDir });
      await testQueue.initialize();

      const job = createPendingDetectionJob('job-no-eventbus');

      // Should not throw
      await expect(testQueue.createJob(job)).resolves.not.toThrow();
    });
  });
});
