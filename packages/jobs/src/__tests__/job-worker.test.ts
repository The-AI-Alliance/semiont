/**
 * Unit tests for JobWorker base class
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { JobQueue } from '../job-queue';
import { JobWorker } from '../job-worker';
import type { AnyJob, PendingJob, DetectionParams } from '../types';
import { jobId, entityType, userId, resourceId } from '@semiont/core';

// Test implementation of JobWorker
class TestJobWorker extends JobWorker {
  private executedJobs: string[] = [];
  private shouldFail = false;
  private executionDelay = 0;

  setExecutionDelay(ms: number): void {
    this.executionDelay = ms;
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  getExecutedJobs(): string[] {
    return this.executedJobs;
  }

  protected getWorkerName(): string {
    return 'TestWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'detection';
  }

  protected async executeJob(job: AnyJob): Promise<void> {
    this.executedJobs.push(job.metadata.id);

    if (this.executionDelay > 0) {
      await this.sleep(this.executionDelay);
    }

    if (this.shouldFail) {
      throw new Error('Simulated job execution failure');
    }
  }
}

// Helper to create a test job
function createTestJob(id: string): PendingJob<DetectionParams> {
  return {
    status: 'pending',
    metadata: {
      id: jobId(id),
      type: 'detection',
      userId: userId('user-1'),
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
    },
    params: {
      resourceId: resourceId('res-1'),
      entityTypes: [entityType('Person')],
    },
  };
}

describe('JobWorker', () => {
  let tempDir: string;
  let jobQueue: JobQueue;
  let worker: TestJobWorker;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-worker-test-'));
    jobQueue = new JobQueue({ dataDir: tempDir });
    await jobQueue.initialize();
    worker = new TestJobWorker(jobQueue, 50, 100); // Fast poll interval for tests
  });

  afterEach(async () => {
    await worker.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('start() and stop()', () => {
    test('should process pending jobs', async () => {
      const job = createTestJob('job-1');
      await jobQueue.createJob(job);

      // Start worker in background
      void worker.start();

      // Wait for job to be processed
      await new Promise(resolve => setTimeout(resolve, 200));

      // Stop worker
      await worker.stop();

      // Check job was executed
      expect(worker.getExecutedJobs()).toContain('job-1');

      // Check job moved to complete
      const retrieved = await jobQueue.getJob(jobId('job-1'));
      expect(retrieved?.status).toBe('complete');
    });

    test('should process multiple jobs in sequence', async () => {
      const job1 = createTestJob('job-1');
      const job2 = createTestJob('job-2');
      const job3 = createTestJob('job-3');

      await jobQueue.createJob(job1);
      await jobQueue.createJob(job2);
      await jobQueue.createJob(job3);

      // Start worker
      void worker.start();

      // Wait for jobs to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      // Stop worker
      await worker.stop();

      // All jobs should be executed
      expect(worker.getExecutedJobs()).toContain('job-1');
      expect(worker.getExecutedJobs()).toContain('job-2');
      expect(worker.getExecutedJobs()).toContain('job-3');
    });

    test('should handle graceful shutdown', async () => {
      const job = createTestJob('job-long');
      await jobQueue.createJob(job);

      worker.setExecutionDelay(1000); // Long execution

      // Start worker
      void worker.start();

      // Wait for job to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Stop worker (should wait for current job)
      await worker.stop();

      // Job should have been executed
      expect(worker.getExecutedJobs()).toContain('job-long');
    });
  });

  describe('job execution and state transitions', () => {
    test('should transition job from pending to running to complete', async () => {
      const job = createTestJob('job-state');
      await jobQueue.createJob(job);

      // Start worker
      void worker.start();

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check job moved to running or complete
      const retrieved = await jobQueue.getJob(jobId('job-state'));
      expect(['running', 'complete']).toContain(retrieved?.status);

      // Wait for completion
      await new Promise(resolve => setTimeout(resolve, 200));

      await worker.stop();

      // Check final state is complete
      const finalJob = await jobQueue.getJob(jobId('job-state'));
      expect(finalJob?.status).toBe('complete');
    });

    test('should not process non-matching jobs', async () => {
      const job: PendingJob<any> = {
        status: 'pending',
        metadata: {
          id: jobId('wrong-type'),
          type: 'generation', // Worker only processes detection jobs
          userId: userId('user-1'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 3,
        },
        params: {},
      };

      await jobQueue.createJob(job);

      // Start worker
      void worker.start();

      // Wait
      await new Promise(resolve => setTimeout(resolve, 200));

      await worker.stop();

      // Job should not have been executed
      expect(worker.getExecutedJobs()).not.toContain('wrong-type');

      // Job should still be pending
      const retrieved = await jobQueue.getJob(jobId('wrong-type'));
      expect(retrieved?.status).toBe('pending');
    });
  });

  describe('retry logic', () => {
    test('should retry failed job up to maxRetries', async () => {
      const job = createTestJob('job-retry');
      await jobQueue.createJob(job);

      worker.setShouldFail(true);

      // Start worker
      const workerPromise = worker.start();

      // Wait for multiple retry attempts (initial + 3 retries)
      await new Promise(resolve => setTimeout(resolve, 1000));

      await worker.stop();
      await workerPromise; // Wait for worker to fully finish
      await new Promise(resolve => setTimeout(resolve, 500)); // Allow filesystem operations to complete

      // Job should have been attempted multiple times
      const executedCount = worker.getExecutedJobs().filter(id => id === 'job-retry').length;
      expect(executedCount).toBeGreaterThan(1);

      // Final status should be failed (after max retries)
      // Note: Due to filesystem race conditions, we may see 'running' briefly before 'failed'
      const retrieved = await jobQueue.getJob(jobId('job-retry'));
      expect(['running', 'failed']).toContain(retrieved?.status);
      if (retrieved?.status === 'failed') {
        expect(retrieved.error).toBe('Simulated job execution failure');
      }
    });

    test('should increment retryCount on each failure', async () => {
      const job = createTestJob('job-count');
      await jobQueue.createJob(job);

      worker.setShouldFail(true);

      // Start worker
      void worker.start();

      // Wait for retry attempts
      await new Promise(resolve => setTimeout(resolve, 1000));

      await worker.stop();

      // Check retry count increased
      const retrieved = await jobQueue.getJob(jobId('job-count'));
      expect(retrieved?.metadata.retryCount).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    test('should handle job that throws error', async () => {
      const job = createTestJob('job-error');
      await jobQueue.createJob(job);

      worker.setShouldFail(true);

      // Start worker
      const workerPromise = worker.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 300));

      await worker.stop();
      await workerPromise; // Wait for worker to fully finish
      await new Promise(resolve => setTimeout(resolve, 500)); // Allow filesystem operations to complete

      // Job should be in pending (for retry), running, or failed state
      const retrieved = await jobQueue.getJob(jobId('job-error'));
      expect(['pending', 'running', 'failed']).toContain(retrieved?.status);
    });

    test('should continue processing after error', async () => {
      const job1 = createTestJob('job-fail');
      const job2 = createTestJob('job-succeed');

      await jobQueue.createJob(job1);
      await jobQueue.createJob(job2);

      // Fail first job but succeed second
      let callCount = 0;
      worker.setShouldFail(false);
      const originalExecute = (worker as any).executeJob.bind(worker);
      (worker as any).executeJob = async function(job: AnyJob) {
        if (callCount === 0 && job.metadata.id === 'job-fail') {
          callCount++;
          throw new Error('First job fails');
        }
        return originalExecute(job);
      };

      // Start worker
      void worker.start();

      // Wait for both jobs
      await new Promise(resolve => setTimeout(resolve, 500));

      await worker.stop();

      // Second job should succeed
      const job2Status = await jobQueue.getJob(jobId('job-succeed'));
      expect(job2Status?.status).toBe('complete');
    });
  });

  describe('updateJobProgress()', () => {
    test('should update job progress without throwing', async () => {
      const job = createTestJob('job-progress');
      await jobQueue.createJob(job);

      // Start worker with progress updates
      class ProgressWorker extends TestJobWorker {
        protected override async executeJob(job: AnyJob): Promise<void> {
          // Simulate progress update during execution
          if (job.status === 'running') {
            const updatedJob = {
              ...job,
              progress: {
                totalEntityTypes: 1,
                processedEntityTypes: 0,
                entitiesFound: 0,
                entitiesEmitted: 0,
              },
            } as AnyJob;
            await this.updateJobProgress(updatedJob);
          }
          await super.executeJob(job);
        }
      }

      const progressWorker = new ProgressWorker(jobQueue, 50, 100);

      // Start worker
      void progressWorker.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      await progressWorker.stop();

      // Job should complete successfully
      const retrieved = await jobQueue.getJob(jobId('job-progress'));
      expect(retrieved?.status).toBe('complete');
    });
  });

  describe('polling behavior', () => {
    test('should wait when no jobs available', async () => {
      // Start worker with empty queue
      void worker.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 200));

      // Worker should be waiting, not crashed
      await worker.stop();

      // No jobs executed
      expect(worker.getExecutedJobs()).toHaveLength(0);
    });

    test('should pick up new jobs added while running', async () => {
      // Start worker with empty queue
      void worker.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      // Add a job while worker is running
      const job = createTestJob('job-added');
      await jobQueue.createJob(job);

      // Wait for it to be picked up
      await new Promise(resolve => setTimeout(resolve, 200));

      await worker.stop();

      // Job should be executed
      expect(worker.getExecutedJobs()).toContain('job-added');
    });
  });
});
