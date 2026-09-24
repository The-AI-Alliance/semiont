import type { AnyJob } from './types';
import type { EventMap, JobId, UnitCursor } from '@semiont/core';

export interface JobQueue {
  initialize(): Promise<void>;
  destroy(): void;
  createJob(job: AnyJob): Promise<void>;
  getJob(jobId: JobId): Promise<AnyJob | null>;
  /**
   * Atomically claim the NEXT pending job matching one of `types` — the ONE
   * transition that makes this a queue rather than a state store
   * (JOB-QUEUE-DRIVER P0; reshaped claim-by-TYPE in P2, while every worker
   * is still ours). pending → running, `startedAt` stamped, progress empty.
   * An announcement is a WAKE-UP, not a reservation: the claimed job may
   * differ from any announced one, no ordering among matching pending jobs
   * is promised, and an empty `types` accepts any type. Simultaneous claims
   * admit one winner PER pending job; a claim that finds nothing is
   * DECLINED (`none-available`), never an error.
   */
  claimNextJob(types: string[]): Promise<{ job: AnyJob } | { declined: 'none-available' }>;
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

/**
 * Every bus channel a queue DRIVER emits, maintained beside the interface
 * both drivers implement and censused against their sources
 * (queue-emits-census.test.ts). The gateway's signal bridge forwards these
 * from its local bus onto the plane — a queue announcement that stays on
 * the raw bus reaches no worker under a remote driver (the job:queued
 * starvation, 2026-09-15).
 */
export const JOB_QUEUE_EMITS = ['job:queued'] as const satisfies readonly (keyof EventMap)[];

/**
 * How long a job's record survives after it reaches a terminal state
 * (complete/failed/cancelled), and how often a driver enforces that.
 *
 * ONE pair for every driver. The window is a CONTRACT fact — a caller that
 * reads a finished job's result gets the same day whichever backing store the
 * stack runs — and the cadence is what turns the window from an aspiration
 * into a promise. Restated per driver the two numbers drift, and the drift is
 * invisible until someone compares two deployments.
 *
 * The METHOD that enforces retention is not on the interface and cannot be:
 * it is an unlink in one driver and a stream purge in another. The NUMBER is
 * here because it is the same number.
 */
export const TERMINAL_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How often a driver sweeps for records past `TERMINAL_JOB_RETENTION_MS`. */
export const TERMINAL_JOB_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
