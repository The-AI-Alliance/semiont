/**
 * Job Worker Base Class
 *
 * Abstract worker that polls the job queue and processes jobs.
 * Subclasses implement specific job processing logic.
 */

import type { AnyJob, RunningJob, CompleteJob, FailedJob, PendingJob } from './types';
import type { JobQueue } from './job-queue';
import type { Logger } from '@semiont/core';

export abstract class JobWorker {
  private running = false;
  private currentJob: AnyJob | null = null;
  private pollIntervalMs: number;
  private errorBackoffMs: number;
  protected jobQueue: JobQueue;
  protected logger: Logger;

  constructor(
    jobQueue: JobQueue,
    pollIntervalMs: number = 1000,
    errorBackoffMs: number = 5000,
    logger: Logger
  ) {
    this.jobQueue = jobQueue;
    this.pollIntervalMs = pollIntervalMs;
    this.errorBackoffMs = errorBackoffMs;
    this.logger = logger;
  }

  /**
   * Start the worker (polls queue in loop)
   */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info('Worker started', { worker: this.getWorkerName() });

    while (this.running) {
      try {
        const job = await this.pollNextJob();

        if (job) {
          await this.processJob(job);
        } else {
          // No jobs available, wait before polling again
          await this.sleep(this.pollIntervalMs);
        }
      } catch (error) {
        this.logger.error('Error in worker main loop', { worker: this.getWorkerName(), error: error instanceof Error ? error.message : String(error) });
        // Back off on error to avoid tight error loops
        await this.sleep(this.errorBackoffMs);
      }
    }

    this.logger.info('Worker stopped', { worker: this.getWorkerName() });
  }

  /**
   * Stop the worker (graceful shutdown)
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping worker', { worker: this.getWorkerName() });
    this.running = false;

    // Wait for current job to finish (with timeout)
    const timeout = 60000; // 60 seconds
    const startTime = Date.now();

    while (this.currentJob && (Date.now() - startTime) < timeout) {
      await this.sleep(100);
    }

    if (this.currentJob) {
      this.logger.warn('Forced worker shutdown', { worker: this.getWorkerName(), jobId: this.currentJob.metadata.id });
    }
  }

  /**
   * Poll for next job to process
   */
  private async pollNextJob(): Promise<AnyJob | null> {
    const job = await this.jobQueue.pollNextPendingJob();

    if (job && this.canProcessJob(job)) {
      return job;
    }

    return null;
  }

  /**
   * Process a job (handles state transitions and error handling)
   */
  private async processJob(job: AnyJob): Promise<void> {
    this.currentJob = job;

    try {
      // Only process pending jobs
      if (job.status !== 'pending') {
        this.logger.warn('Skipping non-pending job', { worker: this.getWorkerName(), jobId: job.metadata.id, status: job.status });
        return;
      }

      // Create running job
      const runningJob: RunningJob<any, any> = {
        status: 'running',
        metadata: job.metadata,
        params: job.params,
        startedAt: new Date().toISOString(),
        progress: {}, // Initialize with empty progress
      };

      await this.jobQueue.updateJob(runningJob, 'pending');

      this.logger.info('Processing job', { worker: this.getWorkerName(), jobId: job.metadata.id, jobType: job.metadata.type });

      // Execute job-specific logic (passing running job) and get result
      const result = await this.executeJob(runningJob);

      // Allow subclasses to emit completion events with result data
      await this.emitCompletionEvent(runningJob, result);

      // Move to complete state with result
      const completeJob: CompleteJob<any, any> = {
        status: 'complete',
        metadata: runningJob.metadata,
        params: runningJob.params,
        startedAt: runningJob.startedAt,
        completedAt: new Date().toISOString(),
        result: result ?? {}, // Use returned result or empty object
      };

      await this.jobQueue.updateJob(completeJob, 'running');

      this.logger.info('Job completed successfully', { worker: this.getWorkerName(), jobId: job.metadata.id });

    } catch (error) {
      await this.handleJobFailure(job, error);
    } finally {
      this.currentJob = null;
    }
  }

  /**
   * Handle job failure (retry or move to failed)
   */
  protected async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    const updatedMetadata = {
      ...job.metadata,
      retryCount: job.metadata.retryCount + 1,
    };

    if (updatedMetadata.retryCount < updatedMetadata.maxRetries) {
      this.logger.info('Job failed, will retry', { worker: this.getWorkerName(), jobId: job.metadata.id, retryCount: updatedMetadata.retryCount, maxRetries: updatedMetadata.maxRetries });
      this.logger.debug('Job error details', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });

      // Move back to pending for retry
      const retryJob: PendingJob<any> = {
        status: 'pending',
        metadata: updatedMetadata,
        params: job.status === 'pending' ? job.params : job.params,
      };

      await this.jobQueue.updateJob(retryJob, job.status);

    } else {
      this.logger.error('Job failed permanently', { worker: this.getWorkerName(), jobId: job.metadata.id, retryCount: updatedMetadata.retryCount });
      this.logger.error('Job error details', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });

      // Move to failed state
      const failedJob: FailedJob<any> = {
        status: 'failed',
        metadata: updatedMetadata,
        params: job.status === 'pending' ? job.params : job.params,
        startedAt: job.status === 'running' ? job.startedAt : undefined,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };

      await this.jobQueue.updateJob(failedJob, job.status);
    }
  }

  /**
   * Update job progress (best-effort, doesn't throw)
   */
  protected async updateJobProgress(job: AnyJob): Promise<void> {
    try {
      await this.jobQueue.updateJob(job);
    } catch (error) {
      this.logger.warn('Failed to update job progress', { worker: this.getWorkerName(), error: error instanceof Error ? error.message : String(error) });
      // Don't throw - progress updates are best-effort
    }
  }

  /**
   * Sleep utility
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Emit completion event (optional hook for subclasses)
   * Override this to emit job-specific completion events (e.g., job.completed)
   */
  protected async emitCompletionEvent(_job: RunningJob<any, any>, _result: any): Promise<void> {
    // Default: do nothing
    // Subclasses can override to emit events
  }

  // Abstract methods to be implemented by subclasses

  /**
   * Get worker name (for logging)
   */
  protected abstract getWorkerName(): string;

  /**
   * Check if this worker can process the given job
   */
  protected abstract canProcessJob(job: AnyJob): boolean;

  /**
   * Execute the job (job-specific logic)
   * This is where the actual work happens
   * Return the result object (or void for jobs without results)
   * Throw an error to trigger retry logic
   */
  protected abstract executeJob(job: AnyJob): Promise<any>;
}
