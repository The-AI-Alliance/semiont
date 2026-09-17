/**
 * FsJobQueue tests.
 *
 * The CONTRACT lives in `job-queue-conformance.ts` (JOB-QUEUE-DRIVER P0) and
 * runs here through the fs fixture — the same suite a second driver must
 * pass. What remains in this file is FsJobQueue-SPECIFIC:
 *
 *   - the on-disk layout (status directories),
 *   - `listJobs` (off the interface; reads migrate to event-log views),
 *   - retention (`cleanupOldJobs` — same migration),
 *   - the `job:queued` announcement protocol (FsJobQueue-era wire, pinned
 *     here until claim-by-type retires it — JOB-QUEUE-DRIVER P1).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FsJobQueue } from '../fs-job-queue';
import type { JobStatus } from '../types';
import { SemiontProject } from '@semiont/core/node';
import { jobId, userId, EventBus, type JobId } from '@semiont/core';
import {
  runJobQueueConformance,
  createPendingDetectionJob,
  createRunningDetectionJob,
  createCompleteDetectionJob,
  createPendingGenerationJob,
} from './job-queue-conformance';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

// ── The conformance suite, through the fs fixture ───────────────────────────

runJobQueueConformance('FsJobQueue', {
  async setup() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-queue-test-'));
    const project = new SemiontProject(tempDir, { anchoredTextDir: `${tempDir}/anchored-text` });
    const opened: FsJobQueue[] = [];

    return {
      async open() {
        const queue = new FsJobQueue(project, mockLogger, new EventBus());
        await queue.initialize();
        opened.push(queue);
        return queue;
      },
      // This driver's staleness signal is the running file's mtime.
      async ageRunningJob(id: JobId) {
        const filePath = path.join(project.jobsDir, 'running', `${id}.json`);
        const past = new Date(Date.now() - 31 * 60_000);
        await fs.utimes(filePath, past, past);
      },
      recoverStale(queue) {
        return (queue as FsJobQueue).recoverStaleRunningJobs();
      },
      async teardown() {
        for (const queue of opened) queue.destroy();
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  },
});

// ── FsJobQueue-specific behavior ────────────────────────────────────────────

describe('FsJobQueue (driver-specific)', () => {
  let tempDir: string;
  let project: SemiontProject;
  let jobQueue: FsJobQueue;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-queue-test-'));
    project = new SemiontProject(tempDir, { anchoredTextDir: `${tempDir}/anchored-text` });
    jobQueue = new FsJobQueue(project, mockLogger, new EventBus());
    await jobQueue.initialize();
  });

  afterEach(async () => {
    jobQueue.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initialize()', () => {
    test('creates all status directories', async () => {
      const statuses: JobStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];

      for (const status of statuses) {
        const statusDir = path.join(project.jobsDir, status);
        const stats = await fs.stat(statusDir);
        expect(stats.isDirectory()).toBe(true);
      }
    });

    test('does not throw if directories already exist', async () => {
      await expect(jobQueue.initialize()).resolves.not.toThrow();
    });
  });

  describe('listJobs()', () => {
    test('should list all jobs', async () => {
      await jobQueue.createJob(createPendingDetectionJob('job-1'));
      await jobQueue.createJob(createRunningDetectionJob('job-2'));
      await jobQueue.createJob(createCompleteDetectionJob('job-3'));

      const jobs = await jobQueue.listJobs();

      expect(jobs.length).toBe(3);
      expect(jobs.map(j => j.metadata.id)).toContain(jobId('job-1'));
      expect(jobs.map(j => j.metadata.id)).toContain(jobId('job-2'));
      expect(jobs.map(j => j.metadata.id)).toContain(jobId('job-3'));
    });

    test('should filter by status', async () => {
      await jobQueue.createJob(createPendingDetectionJob('job-1'));
      await jobQueue.createJob(createRunningDetectionJob('job-2'));

      const pendingJobs = await jobQueue.listJobs({ status: 'pending' });

      expect(pendingJobs.length).toBe(1);
      expect(pendingJobs[0]?.metadata.id).toBe(jobId('job-1'));
    });

    test('should filter by type', async () => {
      await jobQueue.createJob(createPendingDetectionJob('job-1'));
      await jobQueue.createJob(createPendingGenerationJob('job-2'));

      const detectionJobs = await jobQueue.listJobs({ type: 'reference-annotation' });

      expect(detectionJobs.length).toBe(1);
      expect(detectionJobs[0]?.metadata.id).toBe(jobId('job-1'));
    });

    test('should filter by userId', async () => {
      const job1 = createPendingDetectionJob('job-1');
      const base = createPendingDetectionJob('job-2');
      const job2 = { ...base, metadata: { ...base.metadata, userId: userId('user-2') } };

      await jobQueue.createJob(job1);
      await jobQueue.createJob(job2);

      const user1Jobs = await jobQueue.listJobs({ userId: userId('user-1') });

      expect(user1Jobs.length).toBe(1);
      expect(user1Jobs[0]?.metadata.id).toBe(jobId('job-1'));
    });

    test('should apply pagination', async () => {
      await jobQueue.createJob(createPendingDetectionJob('job-1'));
      await jobQueue.createJob(createPendingDetectionJob('job-2'));
      await jobQueue.createJob(createPendingDetectionJob('job-3'));

      const page1 = await jobQueue.listJobs({ limit: 2, offset: 0 });
      const page2 = await jobQueue.listJobs({ limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(1);
    });
  });

  describe('cleanupOldJobs()', () => {
    test('should delete completed jobs older than retention period', async () => {
      const oldJob = createCompleteDetectionJob('job-old');
      // Set completedAt to 2 days ago
      oldJob.completedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

      await jobQueue.createJob(oldJob);

      const deletedCount = await jobQueue.cleanupOldJobs(24); // 24 hour retention

      expect(deletedCount).toBe(1);
      expect(await jobQueue.getJob(jobId('job-old'))).toBeNull();
    });

    test('should not delete recent jobs', async () => {
      await jobQueue.createJob(createCompleteDetectionJob('job-recent'));

      const deletedCount = await jobQueue.cleanupOldJobs(24);

      expect(deletedCount).toBe(0);
      expect(await jobQueue.getJob(jobId('job-recent'))).not.toBeNull();
    });
  });

  // The `job:queued` announcement protocol — FsJobQueue-era wire, not a
  // queue-contract obligation (JOB-QUEUE-DRIVER P0 topology ruling): under
  // claim-by-type (P1) announcements dissolve, so they are pinned with the
  // driver that owns them, not in the conformance suite.
  describe('job:queued announcements', () => {
    test('emits job:queued when creating a job', async () => {
      const eventBus = new EventBus();
      const testQueue = new FsJobQueue(project, mockLogger, eventBus);
      await testQueue.initialize();

      const events: unknown[] = [];
      const job = createPendingDetectionJob('job-with-event');

      eventBus.on('job:queued').subscribe(event => {
        events.push(event);
      });

      await testQueue.createJob(job);
      testQueue.destroy();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        jobId: jobId('job-with-event'),
        jobType: 'reference-annotation',
        resourceId: job.params.resourceId,
        userId: job.metadata.userId,
      });
    });

    test('does not fail when no EventBus is provided', async () => {
      const testQueue = new FsJobQueue(project, mockLogger, undefined);
      await testQueue.initialize();

      await expect(testQueue.createJob(createPendingDetectionJob('job-no-eventbus'))).resolves.not.toThrow();
      testQueue.destroy();
    });

    test('initialize() announces jobs already in pending/', async () => {
      // Backlog written by a previous queue instance (e.g. before a restart)
      await jobQueue.createJob(createPendingDetectionJob('job-backlog-1'));
      await jobQueue.createJob(createPendingDetectionJob('job-backlog-2'));

      const eventBus = new EventBus();
      const events: { jobId: string }[] = [];
      eventBus.on('job:queued').subscribe(event => {
        events.push(event);
      });

      const restarted = new FsJobQueue(project, mockLogger, eventBus);
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
      eventBus.on('job:queued').subscribe(event => {
        events.push(event);
      });

      const restarted = new FsJobQueue(project, mockLogger, eventBus);
      await restarted.initialize();
      restarted.destroy();

      expect(events).toHaveLength(0);
    });

    test('a transient failure with budget left re-announces the retried job', async () => {
      const eventBus = new EventBus();
      const testQueue = new FsJobQueue(project, mockLogger, eventBus);
      await testQueue.initialize();

      await testQueue.createJob(createRunningDetectionJob('job-retry'));

      const events: { jobId: string }[] = [];
      eventBus.on('job:queued').subscribe(event => {
        events.push(event);
      });

      const outcome = await testQueue.failJob(jobId('job-retry'), 'boom', undefined, 'transient');
      testQueue.destroy();

      expect(outcome).toBe('retried');
      expect(events).toHaveLength(1);
      expect(events[0]?.jobId).toBe(jobId('job-retry'));
    });
  });
});
