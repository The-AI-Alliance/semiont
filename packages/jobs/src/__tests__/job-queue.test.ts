/**
 * Unit tests for JobQueue class
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JobQueue } from '../job-queue';
import type { Job, JobStatus, DetectionJob, GenerationJob } from '../types';
import type { JobId, UserId, ResourceId, AnnotationId } from '@semiont/api-client';

describe('JobQueue', () => {
  let tempDir: string;
  let jobQueue: JobQueue;

  beforeEach(async () => {
    // Create a temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-queue-test-'));
    jobQueue = new JobQueue({ dataDir: tempDir });
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
      const job: DetectionJob = {
        id: 'job-123' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person', 'Organization'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);

      const jobPath = path.join(tempDir, 'jobs', 'pending', 'job-123.json');
      const content = await fs.readFile(jobPath, 'utf-8');
      const savedJob = JSON.parse(content);

      expect(savedJob).toEqual(job);
    });

    test('should create a generation job in pending status', async () => {
      const job: GenerationJob = {
        id: 'job-456' as JobId,
        type: 'generation',
        status: 'pending',
        userId: 'user-1' as UserId,
        referenceId: 'ann-1' as AnnotationId,
        sourceResourceId: 'res-1' as ResourceId,
        prompt: 'Generate a summary',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);

      const jobPath = path.join(tempDir, 'jobs', 'pending', 'job-456.json');
      const exists = await fs.access(jobPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('should create job in correct status directory', async () => {
      const job: DetectionJob = {
        id: 'job-running' as JobId,
        type: 'detection',
        status: 'running',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);

      const jobPath = path.join(tempDir, 'jobs', 'running', 'job-running.json');
      const exists = await fs.access(jobPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('getJob()', () => {
    test('should find job in pending status', async () => {
      const job: DetectionJob = {
        id: 'job-123' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const foundJob = await jobQueue.getJob('job-123' as JobId);

      expect(foundJob).toEqual(job);
    });

    test('should find job in running status', async () => {
      const job: DetectionJob = {
        id: 'job-456' as JobId,
        type: 'detection',
        status: 'running',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const foundJob = await jobQueue.getJob('job-456' as JobId);

      expect(foundJob).toEqual(job);
    });

    test('should return null for non-existent job', async () => {
      const foundJob = await jobQueue.getJob('nonexistent' as JobId);
      expect(foundJob).toBeNull();
    });

    test('should search across all status directories', async () => {
      const jobs: DetectionJob[] = [
        {
          id: 'job-pending' as JobId,
          type: 'detection',
          status: 'pending',
          userId: 'user-1' as UserId,
          resourceId: 'res-1' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-running' as JobId,
          type: 'detection',
          status: 'running',
          userId: 'user-1' as UserId,
          resourceId: 'res-1' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-complete' as JobId,
          type: 'detection',
          status: 'complete',
          userId: 'user-1' as UserId,
          resourceId: 'res-1' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
      ];

      for (const job of jobs) {
        await jobQueue.createJob(job);
      }

      for (const job of jobs) {
        const foundJob = await jobQueue.getJob(job.id);
        expect(foundJob).toEqual(job);
      }
    });
  });

  describe('updateJob()', () => {
    test('should update job in same status directory', async () => {
      const job: DetectionJob = {
        id: 'job-123' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);

      // Update progress
      job.progress = {
        totalEntityTypes: 1,
        processedEntityTypes: 1,
        entitiesFound: 5,
        entitiesEmitted: 5,
      };

      await jobQueue.updateJob(job, 'pending');

      const updatedJob = await jobQueue.getJob('job-123' as JobId);
      expect(updatedJob?.progress).toEqual(job.progress);
    });

    test('should move job between status directories atomically', async () => {
      const job: DetectionJob = {
        id: 'job-123' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);

      // Move to running
      job.status = 'running';
      job.startedAt = new Date().toISOString();

      await jobQueue.updateJob(job, 'pending');

      // Verify job moved to running directory
      const runningPath = path.join(tempDir, 'jobs', 'running', 'job-123.json');
      const runningExists = await fs.access(runningPath).then(() => true).catch(() => false);
      expect(runningExists).toBe(true);

      // Verify job removed from pending directory
      const pendingPath = path.join(tempDir, 'jobs', 'pending', 'job-123.json');
      const pendingExists = await fs.access(pendingPath).then(() => true).catch(() => false);
      expect(pendingExists).toBe(false);

      // Verify updated job can be retrieved
      const updatedJob = await jobQueue.getJob('job-123' as JobId);
      expect(updatedJob?.status).toBe('running');
      expect(updatedJob?.startedAt).toBeDefined();
    });

    test('should move job from running to complete', async () => {
      const job: DetectionJob = {
        id: 'job-456' as JobId,
        type: 'detection',
        status: 'running',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);

      // Complete the job
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
      job.result = {
        totalFound: 10,
        totalEmitted: 10,
        errors: 0,
      };

      await jobQueue.updateJob(job, 'running');

      const completedJob = await jobQueue.getJob('job-456' as JobId);
      expect(completedJob?.status).toBe('complete');
      expect(completedJob?.result).toEqual(job.result);
    });

    test('should move job from running to failed', async () => {
      const job: DetectionJob = {
        id: 'job-789' as JobId,
        type: 'detection',
        status: 'running',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);

      // Fail the job
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      job.error = 'Connection timeout';

      await jobQueue.updateJob(job, 'running');

      const failedJob = await jobQueue.getJob('job-789' as JobId);
      expect(failedJob?.status).toBe('failed');
      expect(failedJob?.error).toBe('Connection timeout');
    });
  });

  describe('pollNextPendingJob()', () => {
    test('should return oldest pending job (FIFO)', async () => {
      // Create jobs with different timestamps
      const job1: DetectionJob = {
        id: 'job-001' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: '2024-01-01T00:00:00Z',
        retryCount: 0,
        maxRetries: 3,
      };

      const job2: DetectionJob = {
        id: 'job-002' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-2' as ResourceId,
        entityTypes: ['Organization'],
        created: '2024-01-01T00:01:00Z',
        retryCount: 0,
        maxRetries: 3,
      };

      const job3: DetectionJob = {
        id: 'job-003' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-3' as ResourceId,
        entityTypes: ['Location'],
        created: '2024-01-01T00:02:00Z',
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job2);
      await jobQueue.createJob(job1);
      await jobQueue.createJob(job3);

      // Should return job-001 (oldest by filename sort)
      const nextJob = await jobQueue.pollNextPendingJob();
      expect(nextJob?.id).toBe('job-001');
    });

    test('should return null when no pending jobs', async () => {
      const nextJob = await jobQueue.pollNextPendingJob();
      expect(nextJob).toBeNull();
    });

    test('should not return running jobs', async () => {
      const runningJob: DetectionJob = {
        id: 'job-running' as JobId,
        type: 'detection',
        status: 'running',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(runningJob);

      const nextJob = await jobQueue.pollNextPendingJob();
      expect(nextJob).toBeNull();
    });
  });

  describe('listJobs()', () => {
    beforeEach(async () => {
      // Create multiple jobs in different states
      const jobs: Job[] = [
        {
          id: 'job-pending-1' as JobId,
          type: 'detection',
          status: 'pending',
          userId: 'user-1' as UserId,
          resourceId: 'res-1' as ResourceId,
          entityTypes: ['Person'],
          created: '2024-01-01T00:00:00Z',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-pending-2' as JobId,
          type: 'generation',
          status: 'pending',
          userId: 'user-2' as UserId,
          referenceId: 'ann-1' as AnnotationId,
          sourceResourceId: 'res-2' as ResourceId,
          created: '2024-01-01T00:01:00Z',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-running-1' as JobId,
          type: 'detection',
          status: 'running',
          userId: 'user-1' as UserId,
          resourceId: 'res-3' as ResourceId,
          entityTypes: ['Organization'],
          created: '2024-01-01T00:02:00Z',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-complete-1' as JobId,
          type: 'detection',
          status: 'complete',
          userId: 'user-1' as UserId,
          resourceId: 'res-4' as ResourceId,
          entityTypes: ['Person'],
          created: '2024-01-01T00:03:00Z',
          completedAt: '2024-01-01T00:04:00Z',
          retryCount: 0,
          maxRetries: 3,
        },
      ];

      for (const job of jobs) {
        await jobQueue.createJob(job);
      }
    });

    test('should list all jobs when no filters', async () => {
      const jobs = await jobQueue.listJobs();
      expect(jobs.length).toBe(4);
    });

    test('should filter by status', async () => {
      const pendingJobs = await jobQueue.listJobs({ status: 'pending' });
      expect(pendingJobs.length).toBe(2);
      expect(pendingJobs.every(j => j.status === 'pending')).toBe(true);

      const runningJobs = await jobQueue.listJobs({ status: 'running' });
      expect(runningJobs.length).toBe(1);
      expect(runningJobs[0]?.id).toBe('job-running-1');
    });

    test('should filter by type', async () => {
      const detectionJobs = await jobQueue.listJobs({ type: 'detection' });
      expect(detectionJobs.length).toBe(3);
      expect(detectionJobs.every(j => j.type === 'detection')).toBe(true);

      const generationJobs = await jobQueue.listJobs({ type: 'generation' });
      expect(generationJobs.length).toBe(1);
      expect(generationJobs[0]?.id).toBe('job-pending-2');
    });

    test('should filter by userId', async () => {
      const user1Jobs = await jobQueue.listJobs({ userId: 'user-1' as UserId });
      expect(user1Jobs.length).toBe(3);
      expect(user1Jobs.every(j => j.userId === 'user-1')).toBe(true);

      const user2Jobs = await jobQueue.listJobs({ userId: 'user-2' as UserId });
      expect(user2Jobs.length).toBe(1);
      expect(user2Jobs[0]?.id).toBe('job-pending-2');
    });

    test('should combine multiple filters', async () => {
      const filteredJobs = await jobQueue.listJobs({
        status: 'pending',
        type: 'detection',
        userId: 'user-1' as UserId,
      });

      expect(filteredJobs.length).toBe(1);
      expect(filteredJobs[0]?.id).toBe('job-pending-1');
    });

    test('should sort by created date descending (newest first)', async () => {
      const jobs = await jobQueue.listJobs();

      for (let i = 0; i < jobs.length - 1; i++) {
        const current = new Date(jobs[i]!.created).getTime();
        const next = new Date(jobs[i + 1]!.created).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    test('should apply pagination with limit', async () => {
      const jobs = await jobQueue.listJobs({ limit: 2 });
      expect(jobs.length).toBe(2);
    });

    test('should apply pagination with offset', async () => {
      const jobs = await jobQueue.listJobs({ offset: 2, limit: 2 });
      expect(jobs.length).toBe(2);
    });

    test('should handle empty results', async () => {
      const jobs = await jobQueue.listJobs({ status: 'failed' });
      expect(jobs).toEqual([]);
    });
  });

  describe('cancelJob()', () => {
    test('should cancel pending job', async () => {
      const job: DetectionJob = {
        id: 'job-123' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const cancelled = await jobQueue.cancelJob('job-123' as JobId);

      expect(cancelled).toBe(true);

      const cancelledJob = await jobQueue.getJob('job-123' as JobId);
      expect(cancelledJob?.status).toBe('cancelled');
      expect(cancelledJob?.completedAt).toBeDefined();
    });

    test('should cancel running job', async () => {
      const job: DetectionJob = {
        id: 'job-456' as JobId,
        type: 'detection',
        status: 'running',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const cancelled = await jobQueue.cancelJob('job-456' as JobId);

      expect(cancelled).toBe(true);

      const cancelledJob = await jobQueue.getJob('job-456' as JobId);
      expect(cancelledJob?.status).toBe('cancelled');
    });

    test('should not cancel completed job', async () => {
      const job: DetectionJob = {
        id: 'job-789' as JobId,
        type: 'detection',
        status: 'complete',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const cancelled = await jobQueue.cancelJob('job-789' as JobId);

      expect(cancelled).toBe(false);

      const unchangedJob = await jobQueue.getJob('job-789' as JobId);
      expect(unchangedJob?.status).toBe('complete');
    });

    test('should return false for non-existent job', async () => {
      const cancelled = await jobQueue.cancelJob('nonexistent' as JobId);
      expect(cancelled).toBe(false);
    });
  });

  describe('cleanupOldJobs()', () => {
    test('should delete old completed jobs', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago

      const oldJob: DetectionJob = {
        id: 'job-old' as JobId,
        type: 'detection',
        status: 'complete',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: oldDate,
        completedAt: oldDate,
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(oldJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24); // 24 hour retention
      expect(deletedCount).toBe(1);

      const foundJob = await jobQueue.getJob('job-old' as JobId);
      expect(foundJob).toBeNull();
    });

    test('should not delete recent completed jobs', async () => {
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago

      const recentJob: DetectionJob = {
        id: 'job-recent' as JobId,
        type: 'detection',
        status: 'complete',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: recentDate,
        completedAt: recentDate,
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(recentJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24);
      expect(deletedCount).toBe(0);

      const foundJob = await jobQueue.getJob('job-recent' as JobId);
      expect(foundJob).not.toBeNull();
    });

    test('should not delete pending or running jobs', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const pendingJob: DetectionJob = {
        id: 'job-pending' as JobId,
        type: 'detection',
        status: 'pending',
        userId: 'user-1' as UserId,
        resourceId: 'res-1' as ResourceId,
        entityTypes: ['Person'],
        created: oldDate,
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(pendingJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24);
      expect(deletedCount).toBe(0);

      const foundJob = await jobQueue.getJob('job-pending' as JobId);
      expect(foundJob).not.toBeNull();
    });
  });

  describe('getStats()', () => {
    test('should return stats for all job statuses', async () => {
      const jobs: Job[] = [
        {
          id: 'job-1' as JobId,
          type: 'detection',
          status: 'pending',
          userId: 'user-1' as UserId,
          resourceId: 'res-1' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-2' as JobId,
          type: 'detection',
          status: 'pending',
          userId: 'user-1' as UserId,
          resourceId: 'res-2' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-3' as JobId,
          type: 'detection',
          status: 'running',
          userId: 'user-1' as UserId,
          resourceId: 'res-3' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-4' as JobId,
          type: 'detection',
          status: 'complete',
          userId: 'user-1' as UserId,
          resourceId: 'res-4' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-5' as JobId,
          type: 'detection',
          status: 'complete',
          userId: 'user-1' as UserId,
          resourceId: 'res-5' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: 'job-6' as JobId,
          type: 'detection',
          status: 'failed',
          userId: 'user-1' as UserId,
          resourceId: 'res-6' as ResourceId,
          entityTypes: ['Person'],
          created: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: 'Test error',
          retryCount: 0,
          maxRetries: 3,
        },
      ];

      for (const job of jobs) {
        await jobQueue.createJob(job);
      }

      const stats = await jobQueue.getStats();

      expect(stats.pending).toBe(2);
      expect(stats.running).toBe(1);
      expect(stats.complete).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.cancelled).toBe(0);
    });

    test('should return zero stats when no jobs exist', async () => {
      const stats = await jobQueue.getStats();

      expect(stats.pending).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.complete).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.cancelled).toBe(0);
    });
  });
});
