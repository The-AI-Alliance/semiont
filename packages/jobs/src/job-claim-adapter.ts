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
 * The `bus` parameter is typed against the small `JobClaimBus`
 * interface below so the adapter is transport-neutral. HTTP workers
 * pass `(session.client.transport as HttpTransport).actor`; an
 * in-process worker could pass a shim wrapping `client.bus`.
 */

import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { firstValueFrom, merge, filter, map, take, timeout } from 'rxjs';
import type { WorkerBus } from '@semiont/sdk';

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

  /** Release observables. Does not dispose the shared bus. */
  dispose(): void;
}

/**
 * Attach job-claim behaviour to a shared bus.
 */
export function createJobClaimAdapter(options: JobClaimAdapterOptions): JobClaimAdapter {
  const { bus, jobTypes } = options;

  const activeJob$ = new BehaviorSubject<ActiveJob | null>(null);
  const isProcessing$ = new BehaviorSubject<boolean>(false);
  const jobsCompleted$ = new BehaviorSubject<number>(0);
  const errors$ = new Subject<{ jobId: string; error: string }>();

  let jobSubscription: { unsubscribe(): void } | null = null;
  let started = false;

  const claimJob = async (assignment: JobAssignment): Promise<ActiveJob | null> => {
    try {
      const correlationId = crypto.randomUUID();
      const result$ = merge(
        bus.on$<Record<string, unknown>>('job:claimed').pipe(
          filter((e) => e.correlationId === correlationId),
          map((e) => ({ ok: true as const, response: e.response as Record<string, unknown> })),
        ),
        bus.on$<Record<string, unknown>>('job:claim-failed').pipe(
          filter((e) => e.correlationId === correlationId),
          map(() => ({ ok: false as const })),
        ),
      ).pipe(take(1), timeout(10_000));

      const resultPromise = firstValueFrom(result$);
      await bus.emit('job:claim', { correlationId, jobId: assignment.jobId });
      const result = await resultPromise;

      if (!result.ok) return null;
      const job = result.response as {
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
          const jobType = event.jobType;
          if (jobTypes.length > 0 && !jobTypes.includes(jobType)) return;
          if (isProcessing$.getValue()) return;

          isProcessing$.next(true);
          claimJob({ jobId: event.jobId, type: jobType, resourceId: event.resourceId })
            .then((job) => {
              if (job) {
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
      activeJob$.next(null);
      isProcessing$.next(false);
      jobsCompleted$.next(jobsCompleted$.getValue() + 1);
    },

    failJob: (jid: string, error: string) => {
      activeJob$.next(null);
      isProcessing$.next(false);
      errors$.next({ jobId: jid, error });
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
