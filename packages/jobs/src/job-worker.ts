/**
 * Job Worker Base Class
 *
 * Abstract worker that polls the job queue and processes jobs.
 * Subclasses implement specific job processing logic.
 */

import type { AnyJob, RunningJob, CompleteJob, FailedJob, PendingJob } from './types';
import type { JobQueue } from './job-queue';

export abstract class JobWorker {
  private running = false;
  private currentJob: AnyJob | null = null;
  private pollIntervalMs: number;
  private errorBackoffMs: number;
  protected jobQueue: JobQueue;

  constructor(
    jobQueue: JobQueue,
    pollIntervalMs: number = 1000,
    errorBackoffMs: number = 5000
  ) {
    this.jobQueue = jobQueue;
    this.pollIntervalMs = pollIntervalMs;
    this.errorBackoffMs = errorBackoffMs;
  }

  /**
   * Start the worker (polls queue in loop)
   */
  async start(): Promise<void> {
    this.running = true;
    console.log(`[${this.getWorkerName()}] Started`);

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
        console.error(`[${this.getWorkerName()}] Error in main loop:`, error);
        // Back off on error to avoid tight error loops
        await this.sleep(this.errorBackoffMs);
      }
    }

    console.log(`[${this.getWorkerName()}] Stopped`);
  }

  /**
   * Stop the worker (graceful shutdown)
   */
  async stop(): Promise<void> {
    console.log(`[${this.getWorkerName()}] Stopping...`);
    this.running = false;

    // Wait for current job to finish (with timeout)
    const timeout = 60000; // 60 seconds
    const startTime = Date.now();

    while (this.currentJob && (Date.now() - startTime) < timeout) {
      await this.sleep(100);
    }

    if (this.currentJob) {
      console.warn(`[${this.getWorkerName()}] Forced shutdown while processing job ${this.currentJob.metadata.id}`);
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
        console.warn(`[${this.getWorkerName()}] Skipping non-pending job ${job.metadata.id}`);
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

      console.log(`[${this.getWorkerName()}] 🔄 Processing job ${job.metadata.id} (type: ${job.metadata.type})`);

      // Execute job-specific logic (passing running job)
      await this.executeJob(runningJob);

      // Move to complete state
      const completeJob: CompleteJob<any, any> = {
        status: 'complete',
        metadata: runningJob.metadata,
        params: runningJob.params,
        startedAt: runningJob.startedAt,
        completedAt: new Date().toISOString(),
        result: {}, // Subclass should set this via updateJobProgress
      };

      await this.jobQueue.updateJob(completeJob, 'running');

      console.log(`[${this.getWorkerName()}] ✅ Job ${job.metadata.id} completed successfully`);

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
      console.log(`[${this.getWorkerName()}] Job ${job.metadata.id} failed, will retry (${updatedMetadata.retryCount}/${updatedMetadata.maxRetries})`);
      console.log(`[${this.getWorkerName()}] Error:`, error);

      // Move back to pending for retry
      const retryJob: PendingJob<any> = {
        status: 'pending',
        metadata: updatedMetadata,
        params: job.status === 'pending' ? job.params : job.params,
      };

      await this.jobQueue.updateJob(retryJob, job.status);

    } else {
      console.error(`[${this.getWorkerName()}] ❌ Job ${job.metadata.id} failed permanently after ${updatedMetadata.retryCount} retries`);
      console.error(`[${this.getWorkerName()}] Error:`, error);

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
      console.warn(`[${this.getWorkerName()}] Failed to update job progress:`, error);
      // Don't throw - progress updates are best-effort
    }
  }

  /**
   * Sleep utility
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
   * Throw an error to trigger retry logic
   */
  protected abstract executeJob(job: AnyJob): Promise<void>;
}
