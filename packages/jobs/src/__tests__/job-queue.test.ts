/**
 * Unit tests for JobQueue class
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FsJobQueue as JobQueue } from '../fs-job-queue';
import type { JobStatus, PendingJob, RunningJob, CompleteJob, FailedJob, DetectionParams, DetectionProgress, DetectionResult, GenerationParams } from '../types';
import { SemiontProject } from '@semiont/core/node';
import { entityType, jobId, userId, resourceId, annotationId, EventBus } from '@semiont/core';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

// Test helper - create detection jobs in various states
function createPendingDetectionJob(id: string): PendingJob<DetectionParams> {
  return {
    status: 'pending',
    metadata: {
      id: jobId(id),
      type: 'reference-annotation',
      userId: userId('user-1'),
      userName: 'Test User',
      userEmail: 'test@test.local',
      userDomain: 'test.local',
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
      userName: 'Test User',
      userEmail: 'test@test.local',
      userDomain: 'test.local',
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
      userName: 'Test User',
      userEmail: 'test@test.local',
      userDomain: 'test.local',
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
      userName: 'Test User',
      userEmail: 'test@test.local',
      userDomain: 'test.local',
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
      userName: 'Test User',
      userEmail: 'test@test.local',
      userDomain: 'test.local',
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      referenceId: annotationId('ann-1'),
      sourceResourceId: resourceId('res-1'),
      sourceResourceName: 'Test Resource',
      annotation: {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotationId('test-anno-1'),
        motivation: 'linking',
        target: {
          source: 'http://localhost:4100/resources/test-resource-1',
          selector: [
            { type: 'TextPositionSelector', start: 0, end: 10 },
            { type: 'TextQuoteSelector', exact: 'test text' }
          ]
        },
        body: [{ type: 'TextualBody', value: 'Person', purpose: 'tagging' }]
      },
      prompt: 'Generate a summary',
    },
  };
}

describe('JobQueue', () => {
  let tempDir: string;
  let project: SemiontProject;
  let jobQueue: JobQueue;

  beforeEach(async () => {
    // Create a temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-queue-test-'));
    project = new SemiontProject(tempDir);
    jobQueue = new JobQueue(project, mockLogger, new EventBus());
    await jobQueue.initialize();
  });

  afterEach(async () => {
    // Stop the re-announce interval and clean up temporary directory
    jobQueue.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initialize()', () => {
    test('should create all status directories', async () => {
      const statuses: JobStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];

      for (const status of statuses) {
        const statusDir = path.join(project.jobsDir,status);
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

      const jobPath = path.join(project.jobsDir,'pending', 'job-123.json');
      const content = await fs.readFile(jobPath, 'utf-8');
      const savedJob = JSON.parse(content);

      expect(savedJob).toEqual(job);
    });

    test('should create a generation job in pending status', async () => {
      const job = createPendingGenerationJob('job-456');

      await jobQueue.createJob(job);

      const jobPath = path.join(project.jobsDir,'pending', 'job-456.json');
      const exists = await fs.access(jobPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('should create job in correct status directory', async () => {
      const job = createRunningDetectionJob('job-running');

      await jobQueue.createJob(job);

      const jobPath = path.join(project.jobsDir,'running', 'job-running.json');
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
      const pendingPath = path.join(project.jobsDir,'pending', 'job-123.json');
      const pendingExists = await fs.access(pendingPath).then(() => true).catch(() => false);
      expect(pendingExists).toBe(false);

      // Check new location exists
      const runningPath = path.join(project.jobsDir,'running', 'job-123.json');
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

  describe('pending catch-up', () => {
    test('initialize() announces jobs already in pending/', async () => {
      // Backlog written by a previous queue instance (e.g. before a restart)
      await jobQueue.createJob(createPendingDetectionJob('job-backlog-1'));
      await jobQueue.createJob(createPendingDetectionJob('job-backlog-2'));

      const eventBus = new EventBus();
      const events: { jobId: string }[] = [];
      eventBus.get('job:queued').subscribe(event => {
        events.push(event);
      });

      const restarted = new JobQueue(project, mockLogger, eventBus);
      await restarted.initialize();
      restarted.destroy();

      expect(events.map(e => e.jobId)).toEqual([
        jobId('job-backlog-1'),
        jobId('job-backlog-2'),
      ]);
    });

    test('initialize() announces nothing when pending/ is empty', async () => {
      const eventBus = new EventBus();
      const events: unknown[] = [];
      eventBus.get('job:queued').subscribe(event => {
        events.push(event);
      });

      const restarted = new JobQueue(project, mockLogger, eventBus);
      await restarted.initialize();
      restarted.destroy();

      expect(events).toHaveLength(0);
    });

    test('updateJob() re-announces a job moved back to pending', async () => {
      const eventBus = new EventBus();
      const testQueue = new JobQueue(project, mockLogger, eventBus);
      await testQueue.initialize();

      const failed = createFailedDetectionJob('job-retry');
      await testQueue.createJob(failed);

      const events: { jobId: string }[] = [];
      eventBus.get('job:queued').subscribe(event => {
        events.push(event);
      });

      const retried: PendingJob<DetectionParams> = {
        status: 'pending',
        metadata: failed.metadata,
        params: failed.params,
      };
      await testQueue.updateJob(retried, 'failed');
      testQueue.destroy();

      expect(events).toHaveLength(1);
      expect(events[0]?.jobId).toBe(jobId('job-retry'));
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
      const testQueue = new JobQueue(project, mockLogger, eventBus);
      await testQueue.initialize();

      const events: any[] = [];
      const job = createPendingDetectionJob('job-with-event');

      eventBus.get('job:queued').subscribe(event => {
        events.push(event);
      });

      await testQueue.createJob(job);
      testQueue.destroy();

      // Verify event was emitted
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        jobId: jobId('job-with-event'),
        jobType: 'reference-annotation',
        resourceId: job.params.resourceId,
        userId: job.metadata.userId,
      });
    });

    test('should not fail when EventBus is not provided', async () => {
      const testQueue = new JobQueue(project, mockLogger, undefined);
      await testQueue.initialize();

      const job = createPendingDetectionJob('job-no-eventbus');

      // Should not throw
      await expect(testQueue.createJob(job)).resolves.not.toThrow();
      testQueue.destroy();
    });
  });

  describe('completeJob()', () => {
    test('moves a running job to complete with result and completedAt', async () => {
      const job = createRunningDetectionJob('job-done');
      await jobQueue.createJob(job);

      const result = { totalFound: 3, totalEmitted: 3, errors: 0 };
      const moved = await jobQueue.completeJob(jobId('job-done'), result);

      expect(moved).toBe(true);
      const updated = await jobQueue.getJob(jobId('job-done'));
      expect(updated?.status).toBe('complete');
      if (updated?.status === 'complete') {
        expect(updated.result).toEqual(result);
        expect(updated.startedAt).toBe(job.startedAt);
        expect(updated.completedAt).toBeTruthy();
      }
      const oldPath = path.join(project.jobsDir, 'running', 'job-done.json');
      await expect(fs.access(oldPath)).rejects.toThrow();
    });

    test('is a no-op for a job that is not running', async () => {
      const job = createPendingDetectionJob('job-still-pending');
      await jobQueue.createJob(job);

      const moved = await jobQueue.completeJob(jobId('job-still-pending'), {});

      expect(moved).toBe(false);
      expect((await jobQueue.getJob(jobId('job-still-pending')))?.status).toBe('pending');
    });

    test('returns false for an unknown job', async () => {
      expect(await jobQueue.completeJob(jobId('job-missing'), {})).toBe(false);
    });
  });

  describe('failJob()', () => {
    test('moves a running job back to pending and re-announces while retries remain', async () => {
      const eventBus = new EventBus();
      const testQueue = new JobQueue(project, mockLogger, eventBus);
      await testQueue.initialize();

      const job = createRunningDetectionJob('job-flaky'); // retryCount 0, maxRetries 3
      await testQueue.createJob(job);

      const announced: { jobId: string }[] = [];
      eventBus.get('job:queued').subscribe(event => {
        announced.push(event);
      });

      const outcome = await testQueue.failJob(jobId('job-flaky'), 'inference timeout');
      testQueue.destroy();

      expect(outcome).toBe('retried');
      const updated = await testQueue.getJob(jobId('job-flaky'));
      expect(updated?.status).toBe('pending');
      expect(updated?.metadata.retryCount).toBe(1);
      expect(announced.map(e => e.jobId)).toEqual([jobId('job-flaky')]);
    });

    test('moves a running job to failed when retries are exhausted', async () => {
      const job = createRunningDetectionJob('job-doomed');
      job.metadata.retryCount = 3; // maxRetries is 3
      await jobQueue.createJob(job);

      const outcome = await jobQueue.failJob(jobId('job-doomed'), 'inference exploded');

      expect(outcome).toBe('failed');
      const updated = await jobQueue.getJob(jobId('job-doomed'));
      expect(updated?.status).toBe('failed');
      if (updated?.status === 'failed') {
        expect(updated.error).toBe('inference exploded');
        expect(updated.completedAt).toBeTruthy();
      }
    });

    test('returns null for a job that is not running', async () => {
      const job = createPendingDetectionJob('job-not-started');
      await jobQueue.createJob(job);

      expect(await jobQueue.failJob(jobId('job-not-started'), 'irrelevant')).toBeNull();
      expect((await jobQueue.getJob(jobId('job-not-started')))?.status).toBe('pending');
    });
  });

  describe('recordProgress()', () => {
    test('writes progress into the running job file', async () => {
      const job = createRunningDetectionJob('job-progress');
      await jobQueue.createJob(job);

      await jobQueue.recordProgress(jobId('job-progress'), { stage: 'analyzing', percentage: 40 });

      const updated = await jobQueue.getJob(jobId('job-progress'));
      expect(updated?.status).toBe('running');
      if (updated?.status === 'running') {
        expect(updated.progress).toEqual({ stage: 'analyzing', percentage: 40 });
      }
    });

    test('throttles rapid successive writes', async () => {
      const job = createRunningDetectionJob('job-chatty');
      await jobQueue.createJob(job);

      await jobQueue.recordProgress(jobId('job-chatty'), { stage: 'analyzing', percentage: 10 });
      await jobQueue.recordProgress(jobId('job-chatty'), { stage: 'analyzing', percentage: 11 });

      const updated = await jobQueue.getJob(jobId('job-chatty'));
      expect(updated?.status).toBe('running');
      if (updated?.status === 'running') {
        expect(updated.progress).toEqual({ stage: 'analyzing', percentage: 10 });
      }
    });

    test('writes again once the throttle window has passed', async () => {
      vi.useFakeTimers();
      try {
        const job = createRunningDetectionJob('job-patient');
        await jobQueue.createJob(job);

        await jobQueue.recordProgress(jobId('job-patient'), { stage: 'analyzing', percentage: 10 });
        vi.advanceTimersByTime(6_000);
        await jobQueue.recordProgress(jobId('job-patient'), { stage: 'creating', percentage: 80 });

        const updated = await jobQueue.getJob(jobId('job-patient'));
        expect(updated?.status).toBe('running');
        if (updated?.status === 'running') {
          expect(updated.progress).toEqual({ stage: 'creating', percentage: 80 });
        }
      } finally {
        vi.useRealTimers();
      }
    });

    test('ignores progress for jobs that are not running', async () => {
      const job = createPendingDetectionJob('job-early-progress');
      await jobQueue.createJob(job);

      await jobQueue.recordProgress(jobId('job-early-progress'), { percentage: 50 });

      expect((await jobQueue.getJob(jobId('job-early-progress')))?.status).toBe('pending');
    });
  });

  describe('cancelPendingJobs()', () => {
    test('cancels pending annotation jobs, leaves generation and running jobs alone', async () => {
      await jobQueue.createJob(createPendingDetectionJob('job-ann-1'));
      await jobQueue.createJob(createPendingDetectionJob('job-ann-2'));
      await jobQueue.createJob(createPendingGenerationJob('job-gen-1'));
      await jobQueue.createJob(createRunningDetectionJob('job-ann-running'));

      const cancelled = await jobQueue.cancelPendingJobs('annotation');

      expect(cancelled).toBe(2);
      expect((await jobQueue.getJob(jobId('job-ann-1')))?.status).toBe('cancelled');
      expect((await jobQueue.getJob(jobId('job-ann-2')))?.status).toBe('cancelled');
      expect((await jobQueue.getJob(jobId('job-gen-1')))?.status).toBe('pending');
      expect((await jobQueue.getJob(jobId('job-ann-running')))?.status).toBe('running');
    });

    test("cancels pending generation jobs for the 'generation' category", async () => {
      await jobQueue.createJob(createPendingDetectionJob('job-ann-3'));
      await jobQueue.createJob(createPendingGenerationJob('job-gen-2'));

      const cancelled = await jobQueue.cancelPendingJobs('generation');

      expect(cancelled).toBe(1);
      expect((await jobQueue.getJob(jobId('job-gen-2')))?.status).toBe('cancelled');
      expect((await jobQueue.getJob(jobId('job-ann-3')))?.status).toBe('pending');
    });
  });

  describe('recoverStaleRunningJobs()', () => {
    test('re-queues a stale running job with retries remaining', async () => {
      await jobQueue.createJob(createRunningDetectionJob('job-stale-retry'));
      const filePath = path.join(project.jobsDir, 'running', 'job-stale-retry.json');
      const past = new Date(Date.now() - 31 * 60_000);
      await fs.utimes(filePath, past, past);

      const recovered = await jobQueue.recoverStaleRunningJobs();

      expect(recovered).toBe(1);
      const updated = await jobQueue.getJob(jobId('job-stale-retry'));
      expect(updated?.status).toBe('pending');
      expect(updated?.metadata.retryCount).toBe(1);
    });

    test('fails a stale running job whose retries are exhausted', async () => {
      const job = createRunningDetectionJob('job-stale-dead');
      job.metadata.retryCount = 3;
      await jobQueue.createJob(job);
      const filePath = path.join(project.jobsDir, 'running', 'job-stale-dead.json');
      const past = new Date(Date.now() - 31 * 60_000);
      await fs.utimes(filePath, past, past);

      const recovered = await jobQueue.recoverStaleRunningJobs();

      expect(recovered).toBe(1);
      const updated = await jobQueue.getJob(jobId('job-stale-dead'));
      expect(updated?.status).toBe('failed');
      if (updated?.status === 'failed') {
        expect(updated.error).toContain('presumed dead');
      }
    });

    test('leaves fresh running jobs untouched', async () => {
      await jobQueue.createJob(createRunningDetectionJob('job-fresh'));

      expect(await jobQueue.recoverStaleRunningJobs()).toBe(0);
      expect((await jobQueue.getJob(jobId('job-fresh')))?.status).toBe('running');
    });

    test('a progress write rescues an otherwise-stale running job', async () => {
      // Pins the heartbeat contract: recordProgress must refresh the
      // file's mtime, or the janitor would recover live jobs out from
      // under their workers.
      await jobQueue.createJob(createRunningDetectionJob('job-heartbeat'));
      const filePath = path.join(project.jobsDir, 'running', 'job-heartbeat.json');
      const past = new Date(Date.now() - 31 * 60_000);
      await fs.utimes(filePath, past, past);

      await jobQueue.recordProgress(jobId('job-heartbeat'), { stage: 'analyzing', percentage: 50 });

      expect(await jobQueue.recoverStaleRunningJobs()).toBe(0);
      expect((await jobQueue.getJob(jobId('job-heartbeat')))?.status).toBe('running');
    });
  });
});
