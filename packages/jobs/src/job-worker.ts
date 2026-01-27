/**
 * Job Worker Base Class
 *
 * Abstract worker that polls the job queue and processes jobs.
 * Subclasses implement specific job processing logic.
 */

import type { Job } from './types';
import type { JobQueue } from './job-queue';

export abstract class JobWorker {
  private running = false;
  private currentJob: Job | null = null;
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
      console.warn(`[${this.getWorkerName()}] Forced shutdown while processing job ${this.currentJob.id}`);
    }
  }

  /**
   * Poll for next job to process
   */
  private async pollNextJob(): Promise<Job | null> {
    const job = await this.jobQueue.pollNextPendingJob();

    if (job && this.canProcessJob(job)) {
      return job;
    }

    return null;
  }

  /**
   * Process a job (handles state transitions and error handling)
   */
  private async processJob(job: Job): Promise<void> {
    this.currentJob = job;

    try {
      // Move to running state
      const oldStatus = job.status;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      await this.jobQueue.updateJob(job, oldStatus);

      console.log(`[${this.getWorkerName()}] 🔄 Processing job ${job.id} (type: ${job.type})`);

      // Execute job-specific logic
      await this.executeJob(job);

      // Move to complete state
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
      await this.jobQueue.updateJob(job, 'running');

      console.log(`[${this.getWorkerName()}] ✅ Job ${job.id} completed successfully`);

    } catch (error) {
      await this.handleJobFailure(job, error);
    } finally {
      this.currentJob = null;
    }
  }

  /**
   * Handle job failure (retry or move to failed)
   */
  protected async handleJobFailure(job: Job, error: any): Promise<void> {
    job.retryCount++;

    if (job.retryCount < job.maxRetries) {
      console.log(`[${this.getWorkerName()}] Job ${job.id} failed, will retry (${job.retryCount}/${job.maxRetries})`);
      console.log(`[${this.getWorkerName()}] Error:`, error);

      // Move back to pending for retry
      job.status = 'pending';
      job.startedAt = undefined; // Clear start time for retry
      await this.jobQueue.updateJob(job, 'running');

    } else {
      console.error(`[${this.getWorkerName()}] ❌ Job ${job.id} failed permanently after ${job.retryCount} retries`);
      console.error(`[${this.getWorkerName()}] Error:`, error);

      // Move to failed state
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      await this.jobQueue.updateJob(job, 'running');
    }
  }

  /**
   * Update job progress (best-effort, doesn't throw)
   */
  protected async updateJobProgress(job: Job): Promise<void> {
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
  protected abstract canProcessJob(job: Job): boolean;

  /**
   * Execute the job (job-specific logic)
   * This is where the actual work happens
   * Throw an error to trigger retry logic
   */
  protected abstract executeJob(job: Job): Promise<void>;
}
