/**
 * Unit tests for JobQueue class
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JobQueue } from '../job-queue';
import type { Job, JobStatus, DetectionJob, GenerationJob } from '../types';
import { entityType, jobId } from '@semiont/api-client';
import { userId, resourceId, annotationId } from '@semiont/core';

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
        id: jobId('job-123'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person'), entityType('Organization')],
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
        id: jobId('job-456'),
        type: 'generation',
        status: 'pending',
        userId: userId('user-1'),
        referenceId: annotationId('ann-1'),
        sourceResourceId: resourceId('res-1'),
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
        id: jobId('job-running'),
        type: 'detection',
        status: 'running',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
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
        id: jobId('job-123'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const foundJob = await jobQueue.getJob(jobId('job-123'));

      expect(foundJob).toEqual(job);
    });

    test('should find job in running status', async () => {
      const job: DetectionJob = {
        id: jobId('job-456'),
        type: 'detection',
        status: 'running',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const foundJob = await jobQueue.getJob(jobId('job-456'));

      expect(foundJob).toEqual(job);
    });

    test('should return null for non-existent job', async () => {
      const foundJob = await jobQueue.getJob(jobId('nonexistent'));
      expect(foundJob).toBeNull();
    });

    test('should search across all status directories', async () => {
      const jobs: DetectionJob[] = [
        {
          id: jobId('job-pending'),
          type: 'detection',
          status: 'pending',
          userId: userId('user-1'),
          resourceId: resourceId('res-1'),
          entityTypes: [entityType('Person')],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-running'),
          type: 'detection',
          status: 'running',
          userId: userId('user-1'),
          resourceId: resourceId('res-1'),
          entityTypes: [entityType('Person')],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-complete'),
          type: 'detection',
          status: 'complete',
          userId: userId('user-1'),
          resourceId: resourceId('res-1'),
          entityTypes: [entityType('Person')],
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
        id: jobId('job-123'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
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

      const updatedJob = await jobQueue.getJob(jobId('job-123'));
      expect(updatedJob?.progress).toEqual(job.progress);
    });

    test('should move job between status directories atomically', async () => {
      const job: DetectionJob = {
        id: jobId('job-123'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
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
      const updatedJob = await jobQueue.getJob(jobId('job-123'));
      expect(updatedJob?.status).toBe('running');
      expect(updatedJob?.startedAt).toBeDefined();
    });

    test('should move job from running to complete', async () => {
      const job: DetectionJob = {
        id: jobId('job-456'),
        type: 'detection',
        status: 'running',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
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

      const completedJob = await jobQueue.getJob(jobId('job-456'));
      expect(completedJob?.status).toBe('complete');
      expect(completedJob?.result).toEqual(job.result);
    });

    test('should move job from running to failed', async () => {
      const job: DetectionJob = {
        id: jobId('job-789'),
        type: 'detection',
        status: 'running',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
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

      const failedJob = await jobQueue.getJob(jobId('job-789'));
      expect(failedJob?.status).toBe('failed');
      expect(failedJob?.error).toBe('Connection timeout');
    });
  });

  describe('pollNextPendingJob()', () => {
    test('should return oldest pending job (FIFO)', async () => {
      // Create jobs with different timestamps
      const job1: DetectionJob = {
        id: jobId('job-001'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: '2024-01-01T00:00:00Z',
        retryCount: 0,
        maxRetries: 3,
      };

      const job2: DetectionJob = {
        id: jobId('job-002'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-2'),
        entityTypes: [entityType('Organization')],
        created: '2024-01-01T00:01:00Z',
        retryCount: 0,
        maxRetries: 3,
      };

      const job3: DetectionJob = {
        id: jobId('job-003'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-3'),
        entityTypes: [entityType('Location')],
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
        id: jobId('job-running'),
        type: 'detection',
        status: 'running',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
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
          id: jobId('job-pending-1'),
          type: 'detection',
          status: 'pending',
          userId: userId('user-1'),
          resourceId: resourceId('res-1'),
          entityTypes: [entityType('Person')],
          created: '2024-01-01T00:00:00Z',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-pending-2'),
          type: 'generation',
          status: 'pending',
          userId: userId('user-2'),
          referenceId: annotationId('ann-1'),
          sourceResourceId: resourceId('res-2'),
          created: '2024-01-01T00:01:00Z',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-running-1'),
          type: 'detection',
          status: 'running',
          userId: userId('user-1'),
          resourceId: resourceId('res-3'),
          entityTypes: [entityType('Organization')],
          created: '2024-01-01T00:02:00Z',
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-complete-1'),
          type: 'detection',
          status: 'complete',
          userId: userId('user-1'),
          resourceId: resourceId('res-4'),
          entityTypes: [entityType('Person')],
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
      const user1Jobs = await jobQueue.listJobs({ userId: userId('user-1') });
      expect(user1Jobs.length).toBe(3);
      expect(user1Jobs.every(j => j.userId === 'user-1')).toBe(true);

      const user2Jobs = await jobQueue.listJobs({ userId: userId('user-2') });
      expect(user2Jobs.length).toBe(1);
      expect(user2Jobs[0]?.id).toBe('job-pending-2');
    });

    test('should combine multiple filters', async () => {
      const filteredJobs = await jobQueue.listJobs({
        status: 'pending',
        type: 'detection',
        userId: userId('user-1'),
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
        id: jobId('job-123'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const cancelled = await jobQueue.cancelJob(jobId('job-123'));

      expect(cancelled).toBe(true);

      const cancelledJob = await jobQueue.getJob(jobId('job-123'));
      expect(cancelledJob?.status).toBe('cancelled');
      expect(cancelledJob?.completedAt).toBeDefined();
    });

    test('should cancel running job', async () => {
      const job: DetectionJob = {
        id: jobId('job-456'),
        type: 'detection',
        status: 'running',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const cancelled = await jobQueue.cancelJob(jobId('job-456'));

      expect(cancelled).toBe(true);

      const cancelledJob = await jobQueue.getJob(jobId('job-456'));
      expect(cancelledJob?.status).toBe('cancelled');
    });

    test('should not cancel completed job', async () => {
      const job: DetectionJob = {
        id: jobId('job-789'),
        type: 'detection',
        status: 'complete',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(job);
      const cancelled = await jobQueue.cancelJob(jobId('job-789'));

      expect(cancelled).toBe(false);

      const unchangedJob = await jobQueue.getJob(jobId('job-789'));
      expect(unchangedJob?.status).toBe('complete');
    });

    test('should return false for non-existent job', async () => {
      const cancelled = await jobQueue.cancelJob(jobId('nonexistent'));
      expect(cancelled).toBe(false);
    });
  });

  describe('cleanupOldJobs()', () => {
    test('should delete old completed jobs', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago

      const oldJob: DetectionJob = {
        id: jobId('job-old'),
        type: 'detection',
        status: 'complete',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: oldDate,
        completedAt: oldDate,
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(oldJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24); // 24 hour retention
      expect(deletedCount).toBe(1);

      const foundJob = await jobQueue.getJob(jobId('job-old'));
      expect(foundJob).toBeNull();
    });

    test('should not delete recent completed jobs', async () => {
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago

      const recentJob: DetectionJob = {
        id: jobId('job-recent'),
        type: 'detection',
        status: 'complete',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: recentDate,
        completedAt: recentDate,
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(recentJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24);
      expect(deletedCount).toBe(0);

      const foundJob = await jobQueue.getJob(jobId('job-recent'));
      expect(foundJob).not.toBeNull();
    });

    test('should not delete pending or running jobs', async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const pendingJob: DetectionJob = {
        id: jobId('job-pending'),
        type: 'detection',
        status: 'pending',
        userId: userId('user-1'),
        resourceId: resourceId('res-1'),
        entityTypes: [entityType('Person')],
        created: oldDate,
        retryCount: 0,
        maxRetries: 3,
      };

      await jobQueue.createJob(pendingJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24);
      expect(deletedCount).toBe(0);

      const foundJob = await jobQueue.getJob(jobId('job-pending'));
      expect(foundJob).not.toBeNull();
    });
  });

  describe('getStats()', () => {
    test('should return stats for all job statuses', async () => {
      const jobs: Job[] = [
        {
          id: jobId('job-1'),
          type: 'detection',
          status: 'pending',
          userId: userId('user-1'),
          resourceId: resourceId('res-1'),
          entityTypes: [entityType('Person')],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-2'),
          type: 'detection',
          status: 'pending',
          userId: userId('user-1'),
          resourceId: resourceId('res-2'),
          entityTypes: [entityType('Person')],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-3'),
          type: 'detection',
          status: 'running',
          userId: userId('user-1'),
          resourceId: resourceId('res-3'),
          entityTypes: [entityType('Person')],
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-4'),
          type: 'detection',
          status: 'complete',
          userId: userId('user-1'),
          resourceId: resourceId('res-4'),
          entityTypes: [entityType('Person')],
          created: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-5'),
          type: 'detection',
          status: 'complete',
          userId: userId('user-1'),
          resourceId: resourceId('res-5'),
          entityTypes: [entityType('Person')],
          created: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        {
          id: jobId('job-6'),
          type: 'detection',
          status: 'failed',
          userId: userId('user-1'),
          resourceId: resourceId('res-6'),
          entityTypes: [entityType('Person')],
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
