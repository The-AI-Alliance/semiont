import type { AnyJob, JobStatus } from './types';
import type { JobId, UnitCursor } from '@semiont/core';

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
  failJob(jobId: JobId, error: string, completedUnits?: string[], failureClass?: 'transient' | 'deterministic', unitCursors?: Record<string, UnitCursor>): Promise<'retried' | 'failed' | null>;
  /**
   * Persist a running job's completed-unit checkpoint AT unit completion —
   * not only when a job fails (JOB-RESTART-SAFETY P2). `failJob` carries the
   * checkpoint on a clean failure, but a worker that DIES (crash/OOM/kill)
   * never emits `job:fail`, so its finished units would be lost and the
   * janitor's recovery would redo them. This writes them into the running
   * file's metadata as each unit lands, unioned with any existing
   * checkpoint, so recovery resumes rather than restarts. Unthrottled (a
   * unit completion must never be dropped); a no-op for non-running jobs.
   *
   * `unitCursors` is the finer grain `completedUnits` cannot express
   * (CHUNK-GRAIN-RESUME P2): how far an UNFINISHED unit got, so a job that
   * dies mid-unit resumes there instead of at the top. It is written per
   * committed chunk, not per unit.
   *
   * **The two merge differently, and the difference is the contract.**
   * `completedUnits` is a set, so a union converges under concurrent snapshots
   * — a set only grows. A cursor converges only if the merge is **monotone per
   * unit**: a stale snapshot must never move one backward. `next` and `size`
   * move TOGETHER as one observation; taking `size` from one snapshot and
   * `next` from another would describe a chunk that never existed. A unit that
   * reaches `completedUnits` drops its cursor, so "in progress with a cursor"
   * and "complete" stay structurally exclusive rather than by convention.
   *
   * The rule belongs here rather than to any one driver because it is what
   * makes a cursor safe to merge at all.
   */
  checkpointUnits(jobId: JobId, completedUnits: string[], unitCursors?: Record<string, UnitCursor>): Promise<void>;
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
