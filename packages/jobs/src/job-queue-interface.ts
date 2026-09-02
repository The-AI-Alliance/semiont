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
