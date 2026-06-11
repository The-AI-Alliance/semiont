/**
 * Job Queue Manager
 *
 * Filesystem-based job queue with atomic operations.
 * Jobs are stored in directories by status; status transitions are
 * atomic delete + write across directories.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { AnyJob, JobStatus, JobQueryFilters, CancelledJob, CompleteJob, FailedJob, PendingJob, RunningJob } from './types';
import type { SemiontProject } from '@semiont/core/node';
import { jobId as toJobId, type JobId, type Logger, type EventBus } from '@semiont/core';
import type { JobQueue } from './job-queue-interface';

/**
 * How often pending jobs are re-announced on `job:queued` and stale
 * running jobs are checked for recovery.
 *
 * The announcement in `createJob` only reaches workers that are
 * connected and idle at that moment. Re-announcing every pending job
 * on an interval restores catch-up for everything that announcement
 * misses: all eligible workers busy, a worker offline or mid-SSE-
 * reconnect, or a backend restart with a pending backlog. Claim
 * arbitration (the `job:claim` handler refuses non-pending jobs)
 * makes duplicate announcements harmless.
 */
const REANNOUNCE_INTERVAL_MS = 30_000;

/**
 * A running job whose file hasn't been touched for this long is
 * presumed orphaned by a dead worker and fed through the retry-or-fail
 * path. Progress writes (`recordProgress`) refresh the file's mtime,
 * so this is a heartbeat timeout, not a job-duration limit — but a
 * worker that emits no progress for the whole window will be falsely
 * recovered, so it stays deliberately generous.
 */
const STALE_RUNNING_MS = 30 * 60_000;

/** Minimum spacing between progress writes per job — workers can be chatty. */
const PROGRESS_WRITE_MIN_INTERVAL_MS = 5_000;

/** Terminal jobs (complete/failed/cancelled) are pruned after this long. */
const RETENTION_HOURS = 24;

/** How often the retention pruning runs. */
const CLEANUP_INTERVAL_MS = 3_600_000;

export class FsJobQueue implements JobQueue {
  private jobsDir: string;
  private logger: Logger;
  private reannounceTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-job timestamp of the last progress write, for throttling. */
  private lastProgressWrite = new Map<string, number>();

  constructor(
    project: SemiontProject,
    logger: Logger,
    private eventBus?: EventBus
  ) {
    this.jobsDir = project.jobsDir;
    this.logger = logger;
  }

  /**
   * Initialize job queue directories, announce any pending backlog,
   * and start the re-announce interval. Idempotent.
   */
  async initialize(): Promise<void> {
    const statuses: JobStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];

    for (const status of statuses) {
      const dir = path.join(this.jobsDir, status);
      await fs.mkdir(dir, { recursive: true });
    }

    if (this.eventBus && !this.reannounceTimer) {
      // Jobs left pending across a restart are announced right away…
      await this.announcePendingJobs();
      // …and anything that misses an announcement is retried here, along
      // with recovery of jobs orphaned by a dead worker.
      this.reannounceTimer = setInterval(() => {
        this.announcePendingJobs().catch((error) => {
          this.logger.warn('Pending-job re-announce failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.recoverStaleRunningJobs().catch((error) => {
          this.logger.warn('Stale-running recovery failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, REANNOUNCE_INTERVAL_MS);
      // Don't let the interval keep the process alive on shutdown.
      this.reannounceTimer.unref?.();
    }

    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupOldJobs(RETENTION_HOURS).catch((error) => {
          this.logger.warn('Job retention cleanup failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref?.();
    }

    this.logger.info('Job queue initialized');
  }

  /**
   * Stop the re-announce and retention intervals
   */
  destroy(): void {
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Emit `job:queued` for a pending job, if an EventBus is wired and
   * the job carries a `resourceId` (every current job type does).
   */
  private announce(job: AnyJob): void {
    if (this.eventBus && 'params' in job && 'resourceId' in job.params) {
      this.eventBus.get('job:queued').next({
        jobId: job.metadata.id,
        jobType: job.metadata.type,
        resourceId: job.params.resourceId,
        userId: job.metadata.userId,
      });
    }
  }

  /**
   * Announce every job currently in `pending/`. Files that vanish or
   * fail to parse mid-scan (claimed, cancelled, partially written)
   * are skipped — they're either gone for a good reason or picked up
   * on the next tick.
   */
  private async announcePendingJobs(): Promise<void> {
    const pendingDir = path.join(this.jobsDir, 'pending');
    let files: string[];
    try {
      files = await fs.readdir(pendingDir);
    } catch {
      return;
    }
    files.sort();
    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(pendingDir, file), 'utf-8');
        this.announce(JSON.parse(content) as AnyJob);
      } catch {
        // Skip unreadable files
      }
    }
  }

  /**
   * Create a new job
   */
  async createJob(job: AnyJob): Promise<void> {
    const jobPath = this.getJobPath(job.metadata.id, job.status);
    await fs.writeFile(jobPath, JSON.stringify(job, null, 2), 'utf-8');
    this.logger.info('Job created', { jobId: job.metadata.id, status: job.status });

    if (job.status === 'pending') {
      this.announce(job);
    }
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
      this.logger.info('Job moved', { jobId: job.metadata.id, oldStatus, newStatus: job.status });
      // Re-entering pending (e.g. a retry) is a fresh announcement.
      if (job.status === 'pending') {
        this.announce(job);
      }
    } else {
      this.logger.info('Job updated', { jobId: job.metadata.id, status: job.status });
    }
  }

  /**
   * Move a running job to `complete`. Returns false (and changes
   * nothing) if the job is missing or not running — which also makes
   * duplicate `job:complete` events harmless.
   */
  async completeJob(jobId: JobId, result: Record<string, unknown>): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== 'running') {
      return false;
    }

    this.lastProgressWrite.delete(jobId);
    const completed: CompleteJob<any, any> = {
      status: 'complete',
      metadata: job.metadata,
      params: job.params,
      startedAt: job.startedAt,
      completedAt: new Date().toISOString(),
      result,
    };
    await this.updateJob(completed, 'running');
    return true;
  }

  /**
   * Retry-or-fail a running job. While `retryCount < maxRetries` the
   * job goes back to `pending` with the count bumped (and is
   * re-announced); after that it lands in `failed` with the error.
   * Returns null (and changes nothing) if the job isn't running.
   */
  async failJob(jobId: JobId, error: string): Promise<'retried' | 'failed' | null> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== 'running') {
      return null;
    }

    this.lastProgressWrite.delete(jobId);
    if (job.metadata.retryCount < job.metadata.maxRetries) {
      const retried: PendingJob<any> = {
        status: 'pending',
        metadata: { ...job.metadata, retryCount: job.metadata.retryCount + 1 },
        params: job.params,
      };
      await this.updateJob(retried, 'running');
      return 'retried';
    }

    const failed: FailedJob<any> = {
      status: 'failed',
      metadata: job.metadata,
      params: job.params,
      startedAt: job.startedAt,
      completedAt: new Date().toISOString(),
      error,
    };
    await this.updateJob(failed, 'running');
    return 'failed';
  }

  /**
   * Write progress into a running job's file. Throttled per job, and
   * a no-op for jobs that aren't running. Beyond surfacing live
   * progress to `job:status-requested`, each write refreshes the
   * file's mtime — the heartbeat `recoverStaleRunningJobs` watches.
   */
  async recordProgress(jobId: JobId, progress: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const lastWrite = this.lastProgressWrite.get(jobId) ?? 0;
    if (now - lastWrite < PROGRESS_WRITE_MIN_INTERVAL_MS) {
      return;
    }
    this.lastProgressWrite.set(jobId, now);

    const job = await this.getJob(jobId);
    if (!job || job.status !== 'running') {
      this.lastProgressWrite.delete(jobId);
      return;
    }

    // Written directly (not via updateJob) so chatty progress doesn't
    // flood the info log.
    const updated: RunningJob<any, any> = { ...job, progress };
    await fs.writeFile(this.getJobPath(jobId, 'running'), JSON.stringify(updated, null, 2), 'utf-8');
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
   * Cancel all pending jobs in a category — the granularity of the
   * `job:cancel-requested` UI signal. Running jobs are left to finish:
   * interrupting a worker mid-inference would need a worker-side kill
   * channel that doesn't exist.
   */
  async cancelPendingJobs(category: 'annotation' | 'generation'): Promise<number> {
    const matches = category === 'generation'
      ? (type: string) => type === 'generation'
      : (type: string) => type.endsWith('-annotation');

    const pending = await this.listJobs({ status: 'pending', limit: Number.MAX_SAFE_INTEGER });
    let cancelled = 0;
    for (const job of pending) {
      if (!matches(job.metadata.type)) continue;
      if (await this.cancelJob(job.metadata.id)) {
        cancelled++;
      }
    }

    if (cancelled > 0) {
      this.logger.info('Cancelled pending jobs', { category, cancelled });
    }
    return cancelled;
  }

  /**
   * Recover running jobs orphaned by a dead worker: any `running/`
   * file whose mtime is older than the stale window is fed through
   * the same retry-or-fail path as `job:fail`. Progress writes
   * refresh the mtime, so a live worker is never recovered out from
   * under itself as long as it reports within the window.
   */
  async recoverStaleRunningJobs(): Promise<number> {
    const runningDir = path.join(this.jobsDir, 'running');
    let files: string[];
    try {
      files = await fs.readdir(runningDir);
    } catch {
      return 0;
    }

    const now = Date.now();
    let recovered = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const stat = await fs.stat(path.join(runningDir, file));
        if (now - stat.mtimeMs < STALE_RUNNING_MS) continue;

        const staleId = toJobId(file.slice(0, -'.json'.length));
        const outcome = await this.failJob(
          staleId,
          `worker presumed dead — no progress within ${STALE_RUNNING_MS / 60_000} minutes`,
        );
        if (outcome) {
          this.logger.warn('Recovered stale running job', { jobId: staleId, outcome });
          recovered++;
        }
      } catch {
        // File vanished mid-scan (job finished) — nothing to recover
      }
    }
    return recovered;
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
        this.logger.error('Error cleaning up jobs', { status, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (deletedCount > 0) {
      this.logger.info('Jobs cleaned up', { deletedCount });
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
