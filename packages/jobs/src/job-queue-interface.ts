import type { AnyJob, JobStatus } from './types';
import type { JobId } from '@semiont/core';

export interface JobQueue {
  initialize(): Promise<void>;
  destroy(): void;
  createJob(job: AnyJob): Promise<void>;
  getJob(jobId: JobId): Promise<AnyJob | null>;
  updateJob(job: AnyJob, oldStatus?: JobStatus): Promise<void>;
  /** Move a running job to `complete`. Returns false if the job isn't running. */
  completeJob(jobId: JobId, result: Record<string, unknown>): Promise<boolean>;
  /**
   * Move a running job back to `pending` (retry, re-announced) while
   * `retryCount < maxRetries`, else to `failed`. Returns what happened,
   * or null if the job isn't running. `completedUnits` — the units the
   * failing attempt fully emitted — are unioned into the record's
   * checkpoint (ABANDONED-INFERENCE P2) so a retry skips them. A
   * `failureClass` of 'deterministic' goes straight to `failed` with any
   * budget remaining — a second identical attempt cannot succeed (P3).
   */
  failJob(jobId: JobId, error: string, completedUnits?: string[], failureClass?: 'transient' | 'deterministic'): Promise<'retried' | 'failed' | null>;
  /**
   * Persist a running job's completed-unit checkpoint AT unit completion —
   * not only when a job fails (JOB-RESTART-SAFETY P2). `failJob` carries the
   * checkpoint on a clean failure, but a worker that DIES (crash/OOM/kill)
   * never emits `job:fail`, so its finished units would be lost and the
   * janitor's recovery would redo them. This writes them into the running
   * file's metadata as each unit lands, unioned with any existing
   * checkpoint, so recovery resumes rather than restarts. Unthrottled (a
   * unit completion must never be dropped); a no-op for non-running jobs.
   */
  checkpointUnits(jobId: JobId, completedUnits: string[]): Promise<void>;
  /** Write progress into a running job's file (throttled, best-effort). */
  recordProgress(jobId: JobId, progress: Record<string, unknown>): Promise<void>;
  /**
   * Cancel all pending jobs in a category — 'generation' is the
   * `generation` type; 'annotation' is every `*-annotation` type.
   * Running jobs are left to finish. Returns the number cancelled.
   */
  cancelPendingJobs(category: 'annotation' | 'generation'): Promise<number>;
  cancelJob(jobId: JobId): Promise<boolean>;
  getStats(): Promise<{ pending: number; running: number; complete: number; failed: number; cancelled: number }>;
}
