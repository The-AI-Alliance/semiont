/**
 * Job Claim Adapter — worker-side job lifecycle glue on top of a
 * shared bus.
 *
 * Replaces the old `WorkerStateUnit`, which owned its own actor and
 * duplicated the SSE connection that `SemiontClient` already held.
 * Workers construct a `SemiontSession` normally (one actor, one
 * SSE connection) and use this adapter to attach job-claim behaviour
 * on top of the session's bus.
 *
 * The adapter is intentionally thin: it subscribes to `job:queued`,
 * claims jobs via the existing request-response protocol
 * (`job:claim` → `job:claimed` / `job:claim-failed`), and exposes
 * observables for job orchestration. It does **not** own the bus,
 * has no HTTP concerns, and has no modal state.
 *
 * The `bus` parameter is typed against the small `WorkerBus`
 * interface (from `@semiont/sdk`) so the adapter is transport-neutral.
 * HTTP workers pass `(session.client.transport as HttpTransport).actor`;
 * an in-process worker could pass a shim wrapping `client.bus`.
 */

import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { busRequest, type BusRequestPrimitive, type EventMap } from '@semiont/core';
import type { WorkerBus } from '@semiont/sdk';

/**
 * Adapt the string-typed `WorkerBus` to the `BusRequestPrimitive` that
 * `busRequest` consumes, so job-claim rides the same request/reply path as the
 * SDK instead of a hand-rolled copy of it.
 */
function workerBusAsPrimitive(bus: WorkerBus): BusRequestPrimitive {
  return {
    emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<void> {
      return bus.emit(channel as string, payload as Record<string, unknown>);
    },
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
      return bus.on$<EventMap[K]>(channel as string);
    },
  };
}

export interface JobAssignment {
  jobId: string;
  type: string;
  resourceId: string;
}

export interface ActiveJob {
  jobId: string;
  type: string;
  resourceId: string;
  userId: string;
  params: Record<string, unknown>;
}

export interface JobClaimAdapterOptions {
  /** Shared bus (typically the session's HTTP actor or an in-process bus shim). */
  bus: WorkerBus;
  /**
   * Job types this worker can process. Jobs of other types that
   * arrive on `job:queued` are ignored. Empty array = accept any.
   */
  jobTypes: string[];
}

/**
 * Point-in-time liveness snapshot (WORKER-LIVENESS.md P1). The adapter
 * is the only component that sees every announcement, claim, and finish,
 * so its snapshot is what `/health` reports and the stall watchdog reads.
 *
 * There is no poll loop in this architecture — the honest signals are:
 * `lastQueuedEventAt` (any `job:queued` received, matching or not —
 * transport liveness; the backend re-announces pending jobs every 30s,
 * so this advances whenever the queue is non-empty), and
 * `lastActivityAt` (claim, progress emission, or finish — processing
 * liveness; a job stuck mid-inference stops advancing it).
 */
export interface WorkerVitals {
  lastQueuedEventAt: string | null;
  lastClaimAt: string | null;
  /** Last completion or failure — a failing-but-moving worker is alive. */
  lastFinishedAt: string | null;
  lastActivityAt: string | null;
  activeJob: { jobId: string; type: string; since: string } | null;
  jobsCompleted: number;
}

export interface JobClaimAdapter {
  /** Currently-claimed job, or null when idle. */
  readonly activeJob$: Observable<ActiveJob | null>;
  /** True while a claim is in flight or a job is being processed. */
  readonly isProcessing$: Observable<boolean>;
  /** Monotonically-incrementing count of successfully-completed jobs. */
  readonly jobsCompleted$: Observable<number>;
  /** Stream of job failures (including claim-failed and processing errors). */
  readonly errors$: Observable<{ jobId: string; error: string }>;

  /**
   * Subscribe to `job:queued` events (adding the channel to the actor
   * if not already subscribed) and begin claiming matching jobs.
   * Idempotent — calling `start()` twice is a no-op.
   */
  start(): void;

  /** Stop claiming new jobs. Does not cancel an in-flight job. */
  stop(): void;

  /** Signal successful completion of `activeJob$`. */
  completeJob(): void;

  /** Signal failure of `activeJob$`. Emits on `errors$`. */
  failJob(jobId: string, error: string): void;

  /** Liveness snapshot for `/health` and the stall watchdog. */
  vitals(): WorkerVitals;

  /**
   * Record processing activity. The worker process calls this on every
   * progress emission so a long multi-call job keeps proving liveness
   * between inference calls.
   */
  touchActivity(): void;

  /** Release observables. Does not dispose the shared bus. */
  dispose(): void;
}

/**
 * Attach job-claim behaviour to a shared bus.
 */
export function createJobClaimAdapter(options: JobClaimAdapterOptions): JobClaimAdapter {
  const { bus, jobTypes } = options;
  const requestBus = workerBusAsPrimitive(bus);

  const activeJob$ = new BehaviorSubject<ActiveJob | null>(null);
  const isProcessing$ = new BehaviorSubject<boolean>(false);
  const jobsCompleted$ = new BehaviorSubject<number>(0);
  const errors$ = new Subject<{ jobId: string; error: string }>();

  let jobSubscription: { unsubscribe(): void } | null = null;
  let started = false;

  // Vitals clock (epoch ms internally; rendered as ISO in snapshots).
  let lastQueuedEventAt: number | null = null;
  let lastClaimAt: number | null = null;
  let lastFinishedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let activeSince: number | null = null;
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

  const claimJob = async (assignment: JobAssignment): Promise<ActiveJob | null> => {
    try {
      // Same request/reply path as the SDK: busRequest mints the correlationId,
      // matches the job:claimed / job:claim-failed reply by it, and returns the
      // reply's `response` (the claimed job).
      // `job:claimed`'s response is an untyped `Record<string, unknown>`, so narrow
      // it to the claimed-job shape the worker reads.
      const job = (await busRequest(requestBus, 'job:claim', { jobId: assignment.jobId }, 10_000)) as {
        params?: Record<string, unknown>;
        metadata?: { userId?: string };
      };

      return {
        jobId: assignment.jobId,
        type: assignment.type,
        resourceId: assignment.resourceId,
        userId: (job.metadata?.userId ?? '') as string,
        params: (job.params ?? {}) as Record<string, unknown>,
      };
    } catch {
      // A claim-failed reply (job not pending / already claimed / queue error)
      // or a timeout surfaces as a thrown BusRequestError; in every case the
      // worker just moves on — matching the prior race() semantics (null).
      return null;
    }
  };

  return {
    activeJob$: activeJob$.asObservable(),
    isProcessing$: isProcessing$.asObservable(),
    jobsCompleted$: jobsCompleted$.asObservable(),
    errors$: errors$.asObservable(),

    start: () => {
      if (started) return;
      started = true;
      // `job:queued` is not in BRIDGED_CHANNELS (it's a worker-only
      // broadcast). On HTTP, widen the SSE subscription set so this
      // adapter sees queued jobs; in-process buses receive every
      // emit and need no widening, hence the optional chain.
      bus.addChannels?.(['job:queued']);

      jobSubscription = bus
        .on$<{ jobId: string; jobType: string; resourceId: string }>('job:queued')
        .subscribe((event) => {
          // Every announcement received — matching or not — proves the
          // transport is alive; stamp before any filtering.
          lastQueuedEventAt = Date.now();

          const jobType = event.jobType;
          if (jobTypes.length > 0 && !jobTypes.includes(jobType)) return;
          if (isProcessing$.getValue()) return;

          isProcessing$.next(true);
          claimJob({ jobId: event.jobId, type: jobType, resourceId: event.resourceId })
            .then((job) => {
              if (job) {
                const now = Date.now();
                lastClaimAt = now;
                lastActivityAt = now;
                activeSince = now;
                activeJob$.next(job);
              } else {
                isProcessing$.next(false);
              }
            })
            .catch(() => {
              isProcessing$.next(false);
            });
        });
    },

    stop: () => {
      jobSubscription?.unsubscribe();
      jobSubscription = null;
      started = false;
    },

    completeJob: () => {
      const now = Date.now();
      lastFinishedAt = now;
      lastActivityAt = now;
      activeSince = null;
      activeJob$.next(null);
      isProcessing$.next(false);
      jobsCompleted$.next(jobsCompleted$.getValue() + 1);
    },

    failJob: (jid: string, error: string) => {
      const now = Date.now();
      lastFinishedAt = now;
      lastActivityAt = now;
      activeSince = null;
      activeJob$.next(null);
      isProcessing$.next(false);
      errors$.next({ jobId: jid, error });
    },

    vitals: () => {
      const active = activeJob$.getValue();
      return {
        lastQueuedEventAt: iso(lastQueuedEventAt),
        lastClaimAt: iso(lastClaimAt),
        lastFinishedAt: iso(lastFinishedAt),
        lastActivityAt: iso(lastActivityAt),
        activeJob: active && activeSince !== null
          ? { jobId: active.jobId, type: active.type, since: iso(activeSince)! }
          : null,
        jobsCompleted: jobsCompleted$.getValue(),
      };
    },

    touchActivity: () => {
      lastActivityAt = Date.now();
    },

    dispose: () => {
      jobSubscription?.unsubscribe();
      jobSubscription = null;
      started = false;
      activeJob$.complete();
      isProcessing$.complete();
      jobsCompleted$.complete();
      errors$.complete();
    },
  };
}
