/**
 * Job Queue Manager
 *
 * Filesystem-based job queue with atomic operations.
 * Jobs are stored in directories by status for easy polling.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { AnyJob, JobStatus, JobQueryFilters, CancelledJob } from './types';
import type { JobId } from '@semiont/core';

export interface JobQueueConfig {
  dataDir: string;
}

export class JobQueue {
  private jobsDir: string;

  constructor(config: JobQueueConfig) {
    this.jobsDir = path.join(config.dataDir, 'jobs');
  }

  /**
   * Initialize job queue directories
   */
  async initialize(): Promise<void> {
    const statuses: JobStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];

    for (const status of statuses) {
      const dir = path.join(this.jobsDir, status);
      await fs.mkdir(dir, { recursive: true });
    }

    console.log('[JobQueue] Initialized job directories');
  }

  /**
   * Create a new job
   */
  async createJob(job: AnyJob): Promise<void> {
    const jobPath = this.getJobPath(job.metadata.id, job.status);
    await fs.writeFile(jobPath, JSON.stringify(job, null, 2), 'utf-8');
    console.log(`[JobQueue] Created job ${job.metadata.id} with status ${job.status}`);
  }

  /**
   * Get a job by ID (searches all status directories)
   */
  async getJob(jobId: JobId): Promise<AnyJob | null> {
    const statuses: JobStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];

    for (const status of statuses) {
      const jobPath = this.getJobPath(jobId, status);
      try {
        const content = await fs.readFile(jobPath, 'utf-8');
        return JSON.parse(content) as AnyJob;
      } catch (error) {
        // File doesn't exist in this status directory, try next
        continue;
      }
    }

    return null;
  }

  /**
   * Update a job (atomic: delete old, write new)
   */
  async updateJob(job: AnyJob, oldStatus?: JobStatus): Promise<void> {
    // If oldStatus provided, delete from old location
    if (oldStatus && oldStatus !== job.status) {
      const oldPath = this.getJobPath(job.metadata.id, oldStatus);
      try {
        await fs.unlink(oldPath);
      } catch (error) {
        // Ignore if file doesn't exist
      }
    }

    // Write to new location
    const newPath = this.getJobPath(job.metadata.id, job.status);
    await fs.writeFile(newPath, JSON.stringify(job, null, 2), 'utf-8');

    if (oldStatus && oldStatus !== job.status) {
      console.log(`[JobQueue] Moved job ${job.metadata.id} from ${oldStatus} to ${job.status}`);
    } else {
      console.log(`[JobQueue] Updated job ${job.metadata.id} (status: ${job.status})`);
    }
  }

  /**
   * Poll for next pending job (FIFO)
   */
  async pollNextPendingJob(): Promise<AnyJob | null> {
    const pendingDir = path.join(this.jobsDir, 'pending');

    try {
      const files = await fs.readdir(pendingDir);

      if (files.length === 0) {
        return null;
      }

      // Sort by filename (job IDs have timestamps via nanoid)
      files.sort();

      const jobFile = files[0]!;
      const jobPath = path.join(pendingDir, jobFile);

      const content = await fs.readFile(jobPath, 'utf-8');
      return JSON.parse(content) as AnyJob;
    } catch (error) {
      console.error('[JobQueue] Error polling pending jobs:', error);
      return null;
    }
  }

  /**
   * List jobs with filters
   */
  async listJobs(filters: JobQueryFilters = {}): Promise<AnyJob[]> {
    const jobs: AnyJob[] = [];

    // Determine which status directories to scan
    const statuses: JobStatus[] = filters.status
      ? [filters.status]
      : ['pending', 'running', 'complete', 'failed', 'cancelled'];

    for (const status of statuses) {
      const statusDir = path.join(this.jobsDir, status);

      try {
        const files = await fs.readdir(statusDir);

        for (const file of files) {
          const jobPath = path.join(statusDir, file);
          const content = await fs.readFile(jobPath, 'utf-8');
          const job = JSON.parse(content) as AnyJob;

          // Apply filters
          if (filters.type && job.metadata.type !== filters.type) continue;
          if (filters.userId && job.metadata.userId !== filters.userId) continue;

          jobs.push(job);
        }
      } catch (error) {
        // Directory might not exist yet
        continue;
      }
    }

    // Sort by created descending (newest first)
    jobs.sort((a, b) => new Date(b.metadata.created).getTime() - new Date(a.metadata.created).getTime());

    // Apply pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 100;

    return jobs.slice(offset, offset + limit);
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: JobId): Promise<boolean> {
    const job = await this.getJob(jobId);

    if (!job) {
      return false;
    }

    // Can only cancel pending or running jobs
    if (job.status !== 'pending' && job.status !== 'running') {
      return false;
    }

    const oldStatus = job.status;

    // Create cancelled job with proper structure
    const cancelledJob: CancelledJob<any> = {
      status: 'cancelled',
      metadata: job.metadata,
      params: job.status === 'pending' ? job.params : job.params,
      startedAt: job.status === 'running' ? job.startedAt : undefined,
      completedAt: new Date().toISOString(),
    };

    await this.updateJob(cancelledJob, oldStatus);
    return true;
  }

  /**
   * Clean up old completed/failed jobs (older than retention period)
   */
  async cleanupOldJobs(retentionHours: number = 24): Promise<number> {
    const cutoffTime = Date.now() - (retentionHours * 60 * 60 * 1000);
    let deletedCount = 0;

    const cleanupStatuses: JobStatus[] = ['complete', 'failed', 'cancelled'];

    for (const status of cleanupStatuses) {
      const statusDir = path.join(this.jobsDir, status);

      try {
        const files = await fs.readdir(statusDir);

        for (const file of files) {
          const jobPath = path.join(statusDir, file);
          const content = await fs.readFile(jobPath, 'utf-8');
          const job = JSON.parse(content) as AnyJob;

          if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
            const completedTime = new Date(job.completedAt).getTime();

            if (completedTime < cutoffTime) {
              await fs.unlink(jobPath);
              deletedCount++;
            }
          }
        }
      } catch (error) {
        console.error(`[JobQueue] Error cleaning up ${status} jobs:`, error);
      }
    }

    if (deletedCount > 0) {
      console.log(`[JobQueue] Cleaned up ${deletedCount} old jobs`);
    }

    return deletedCount;
  }

  /**
   * Get job file path
   */
  private getJobPath(jobId: JobId, status: JobStatus): string {
    return path.join(this.jobsDir, status, `${jobId}.json`);
  }

  /**
   * Get statistics about the queue
   */
  async getStats(): Promise<{
    pending: number;
    running: number;
    complete: number;
    failed: number;
    cancelled: number;
  }> {
    const stats = {
      pending: 0,
      running: 0,
      complete: 0,
      failed: 0,
      cancelled: 0
    };

    const statuses: JobStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];

    for (const status of statuses) {
      const statusDir = path.join(this.jobsDir, status);

      try {
        const files = await fs.readdir(statusDir);
        stats[status] = files.length;
      } catch (error) {
        // Directory might not exist yet
        stats[status] = 0;
      }
    }

    return stats;
  }
}

// Singleton instance
let jobQueue: JobQueue | null = null;

export function getJobQueue(): JobQueue {
  if (!jobQueue) {
    throw new Error('JobQueue not initialized. Call initializeJobQueue() first.');
  }
  return jobQueue;
}

export async function initializeJobQueue(config: JobQueueConfig): Promise<JobQueue> {
  jobQueue = new JobQueue(config);
  await jobQueue.initialize();
  return jobQueue;
}
