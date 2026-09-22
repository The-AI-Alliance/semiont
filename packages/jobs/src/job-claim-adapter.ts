/**
 * Job Claim Adapter — worker-side job lifecycle glue on top of a
 * shared bus.
 *
 * Replaces the old `WorkerStateUnit`, which owned its own actor and
 * duplicated the SSE connection that `SemiontClient` already held.
 * Workers construct a `SemiontSession` normally (one actor, one
 * SSE connection) and use this adapter to attach job-claim behaviour
 * on top of the session's bus. It does **not** own the bus, has no HTTP
 * concerns, and has no modal state.
 *
 * THE MODEL — a worker asks the queue at every moment it becomes idle,
 * and never otherwise. `job:claim` carries this worker's types; the
 * dispatcher answers with the next pending job of those types, atomically
 * claimed, or declines. Queue state is the truth; no message carries
 * correctness. The idle moments:
 *
 *   - start, once the transport is open;
 *   - settle — `completeJob` / `failJob` — immediately, with no timer;
 *   - a matching `job:queued` while parked;
 *   - reconnect — every `state$` edge into `open` after the first.
 *
 * `job:queued` is a WAKE-UP with no memory. While parked it triggers a
 * pull; while a claim is in flight it sets a dirty bit that earns exactly
 * one more pull before parking, so a wake-up cannot be lost in that window;
 * while a job is held it is ignored, because the settle pulls. One claim
 * in flight at a time — under one-job-at-a-time processing "drain" is one
 * claim per idle moment and one at settle, never a loop of claims while a
 * job is held. The type filter on the wake-up is a PRE-FILTER on
 * information the announcement already carries, so a worker that cannot
 * run the announced type does not spend a round trip to be declined; the
 * claim's `types` argument is the rule.
 *
 * What the dispatcher's decline codes mean here (`BusRequestError.code`,
 * promoted from the reply's `CommandError.code`): `bus.none-pending` is
 * the quiet park — nothing to do until a wake-up, nothing emitted. Every
 * other refusal goes out on `refused$` for the runtime to judge;
 * `bus.unauthorized` is the one it exits on, because a credential that
 * can never claim has nothing to do here and the launcher's preflight
 * names the repair.
 *
 * The queue drivers' 30 s re-announce tick survives as INSURANCE against a
 * lost wake-up on an idle worker — never as dispatch. A healthy stack never
 * sees it act.
 *
 * The `bus` parameter is typed against the small `BusRequestPrimitive`
 * interface (from `@semiont/core`) so the adapter is transport-neutral.
 * HTTP workers pass `(session.client.transport as HttpTransport).actor`;
 * an in-process worker could pass a shim wrapping `client.bus`.
 */

import { BehaviorSubject, Observable, Subject, type Subscription } from 'rxjs';
import { BusRequestError, busRequest, isArray, isNumber, isObject, isString } from '@semiont/core';
import type { BusRequestErrorCode, UnitCursor } from '@semiont/core';
import type { BusRequestPrimitive } from '@semiont/core';

/**
 * The bus operation the claim path AWAITS (census declaration — see
 * `WORKER_AWAITED_OPERATIONS` in worker-runtime.ts). The `satisfies` at the
 * call site keeps this alias and the actual operation from drifting.
 */
export type JobClaimAwaits = 'job:claim';

/**
 * Narrow the claimed record's `unitCursors` metadata to usable cursors.
 *
 * A malformed or partial entry is DROPPED, never repaired: the unit then starts
 * from the top, which costs inference but is always correct, whereas a
 * manufactured position would skip text nobody ever read and the gap would be
 * undetectable afterwards. Cursors for units already in `completedUnits` are
 * dropped too — the queue keeps those sets disjoint, and a reader that trusted
 * a stale one would resume a unit that is done.
 */
function readUnitCursors(raw: unknown, completedUnits: string[]): Record<string, UnitCursor> {
  if (!isObject(raw)) return {};
  const done = new Set(completedUnits);
  const cursors: Record<string, UnitCursor> = {};
  for (const [unit, value] of Object.entries(raw)) {
    if (done.has(unit) || !isObject(value)) continue;
    const { next, size, found, emitted } = value;
    if (!isNumber(next) || !isNumber(size) || next < 0 || size < 1) continue;
    // The tallies are required, and a cursor missing them is dropped WHOLE
    // rather than resumed without them. Resuming would take the saving and then
    // report a terminal record that counts only the remainder — the exact lie
    // HD3 exists to remove. Dropping costs one re-run of a unit and yields a
    // record that is true; a checkpoint written before this field existed reads
    // as absent and takes that trade.
    if (!isNumber(found) || !isNumber(emitted) || found < 0 || emitted < 0) continue;
    cursors[unit] = { next, size, found, emitted };
  }
  return cursors;
}

export interface ActiveJob {
  jobId: string;
  type: string;
  resourceId: string;
  userId: string;
  params: Record<string, unknown>;
  /**
   * Entity-type units earlier failed attempts fully emitted
   * (ABANDONED-INFERENCE P2 checkpointed resume) — carried on the claimed
   * record's metadata by `failJob`. The worker skips them, so a retry
   * neither redoes nor duplicates completed work. Empty on first attempts.
   */
  completedUnits: string[];
  /**
   * How far each UNFINISHED unit got on an earlier attempt
   * (CHUNK-GRAIN-RESUME P2) — the grain `completedUnits` cannot express, and
   * the only checkpoint a one-unit job can produce before it finishes. Empty
   * on first attempts, and never overlapping `completedUnits`: a unit is
   * either finished or partway, never both.
   */
  unitCursors: Record<string, UnitCursor>;
  /**
   * The claimed record's retry budget, carried so the worker can report
   * `willRetry` on `job:fail` (JOB-RESTART-SAFETY P5). It is the same budget
   * the queue re-reads at `failJob`, and only `failJob` changes it, so the
   * two evaluations of `willRetryAfter` agree.
   */
  retryCount: number;
  maxRetries: number;
}

export interface JobClaimAdapterOptions {
  /** Shared bus (typically the session's HTTP actor or an in-process bus shim). */
  bus: BusRequestPrimitive;
  /**
   * Job types this worker can process — the claim's `types` argument, and
   * the pre-filter on `job:queued` wake-ups. Empty array = accept any.
   */
  jobTypes: string[];
}

/**
 * A claim the dispatcher refused for a reason other than "nothing pending".
 *
 * `code` is the `BusRequestError` code the reply was promoted to, or `null`
 * when the failure was local — an unusable record, a thrown non-bus error —
 * never a manufactured bus code. `bus.none-pending` never appears here: it is
 * the quiet park, and emitting it would make an empty queue look like a fault.
 */
export interface ClaimRefusal {
  code: BusRequestErrorCode | null;
  message: string;
}

/**
 * Point-in-time liveness snapshot (WORKER-LIVENESS.md P1). The adapter
 * is the only component that sees every wake-up, claim, and finish,
 * so its snapshot is what `/health` reports and the stall watchdog reads.
 *
 * `lastQueuedEventAt` is any `job:queued` received, matching or not. It
 * proves the transport delivered a broadcast, but on an idle stack with an
 * empty queue it stands still by design — no announcement is owed — so a
 * still stamp alone is not a transport fault; transport liveness proper is
 * the actor's SSE heartbeat. `lastActivityAt` (claim, progress emission, or
 * finish) is processing liveness; a job stuck mid-inference stops advancing
 * it, and that is what the watchdog reads.
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
  /** Stream of job failures reported through `failJob`. */
  readonly errors$: Observable<{ jobId: string; error: string }>;
  /**
   * Claims the dispatcher refused for a reason the runtime must judge.
   * `bus.unauthorized` means this credential can never claim; the runtime
   * exits on it. Anything else is logged and the worker stays parked until
   * the next wake-up. See `ClaimRefusal`.
   */
  readonly refused$: Observable<ClaimRefusal>;

  /**
   * Begin pulling: one claim now (once the transport is open), then on every
   * settle, matching wake-up, and reconnect. Idempotent — calling `start()`
   * twice is a no-op.
   */
  start(): void;

  /** Stop pulling. Does not cancel an in-flight job. */
  stop(): void;

  /** Signal successful completion of `activeJob$`. Pulls the next job. */
  completeJob(): void;

  /** Signal failure of `activeJob$`. Emits on `errors$`, then pulls the next job. */
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

type ClaimOutcome = { job: ActiveJob } | { declined: true } | { refused: ClaimRefusal };

/**
 * Attach job-claim behaviour to a shared bus.
 */
export function createJobClaimAdapter(options: JobClaimAdapterOptions): JobClaimAdapter {
  const { bus, jobTypes } = options;

  const activeJob$ = new BehaviorSubject<ActiveJob | null>(null);
  const isProcessing$ = new BehaviorSubject<boolean>(false);
  const jobsCompleted$ = new BehaviorSubject<number>(0);
  const errors$ = new Subject<{ jobId: string; error: string }>();
  const refused$ = new Subject<ClaimRefusal>();

  let subscriptions: Subscription[] = [];
  let started = false;
  // The loop's two bits: one claim in flight at a time, and a wake-up that
  // arrived during it — honoured with exactly one more claim before parking.
  let claimInFlight = false;
  let wakePending = false;

  // Vitals clock (epoch ms internally; rendered as ISO in snapshots).
  let lastQueuedEventAt: number | null = null;
  let lastClaimAt: number | null = null;
  let lastFinishedAt: number | null = null;
  let lastActivityAt: number | null = null;
  let activeSince: number | null = null;
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

  const claimNext = async (): Promise<ClaimOutcome> => {
    // Ask for the next pending job of this worker's types (JOB-QUEUE-DRIVER
    // P2). Same request/reply path as the SDK: busRequest mints the
    // correlationId, matches the job:claimed / job:claim-failed reply by it,
    // and returns the reply's `response` — an untyped `Record<string,
    // unknown>`, so narrow it to the claimed-job shape the worker reads.
    let record: {
      params?: Record<string, unknown>;
      metadata?: { id?: string; type?: string; userId?: string; completedUnits?: unknown; unitCursors?: unknown; retryCount?: unknown; maxRetries?: unknown };
    };
    try {
      record = (await busRequest(bus, 'job:claim' satisfies JobClaimAwaits, { types: jobTypes }, 10_000)) as typeof record;
    } catch (error) {
      // The reply's verdict, promoted to the client vocabulary by core. A
      // decline is the expected quiet outcome; everything else is the
      // runtime's to judge. A non-bus throw is local and says so (`null`).
      if (error instanceof BusRequestError) {
        if (error.code === 'bus.none-pending') return { declined: true };
        return { refused: { code: error.code, message: error.message } };
      }
      return { refused: { code: null, message: error instanceof Error ? error.message : String(error) } };
    }

    // The claimed job's identity comes from the RESPONSE. A record without
    // one is unusable — refused locally, never run.
    if (!isString(record.metadata?.id) || !isString(record.metadata?.type)) {
      return { refused: { code: null, message: 'claimed record carries no job id or type' } };
    }

    const completedUnits = isArray(record.metadata?.completedUnits)
      ? record.metadata.completedUnits.filter(isString)
      : [];
    const unitCursors = readUnitCursors(record.metadata?.unitCursors, completedUnits);
    const params = (record.params ?? {}) as Record<string, unknown>;

    return {
      job: {
        jobId: record.metadata.id,
        type: record.metadata.type,
        resourceId: isString(params.resourceId) ? params.resourceId : '',
        userId: (record.metadata?.userId ?? '') as string,
        params,
        completedUnits,
        unitCursors,
        // Absent or malformed metadata reads as "no budget left" — a worker
        // that cannot see the budget must not claim a retry is coming.
        retryCount: isNumber(record.metadata?.retryCount) ? record.metadata.retryCount : 0,
        maxRetries: isNumber(record.metadata?.maxRetries) ? record.metadata.maxRetries : 0,
      },
    };
  };

  /** One idle moment: ask once, or remember that we were asked to. */
  const pull = (): void => {
    if (!started) return;
    // Holding a job: the settle pulls. Nothing to remember — the queue's
    // state, not this wake-up, is what the settle pull reads.
    if (activeJob$.getValue() !== null) return;
    if (claimInFlight) {
      wakePending = true;
      return;
    }
    claimInFlight = true;
    wakePending = false;
    isProcessing$.next(true);
    void claimNext().then((outcome) => {
      claimInFlight = false;
      if ('job' in outcome) {
        const now = Date.now();
        lastClaimAt = now;
        lastActivityAt = now;
        activeSince = now;
        // A wake-up that arrived mid-claim is moot: the settle pulls.
        wakePending = false;
        activeJob$.next(outcome.job);
        return;
      }
      if ('refused' in outcome) refused$.next(outcome.refused);
      isProcessing$.next(false);
      if (wakePending) {
        wakePending = false;
        pull();
      }
    });
  };

  return {
    activeJob$: activeJob$.asObservable(),
    isProcessing$: isProcessing$.asObservable(),
    jobsCompleted$: jobsCompleted$.asObservable(),
    errors$: errors$.asObservable(),
    refused$: refused$.asObservable(),

    start: () => {
      if (started) return;
      started = true;

      // `job:queued` is declared twice over, and both halves are load-bearing:
      // as a bridged broadcast so the frame exists on the wire at all, and in
      // `WORKER_CONSUMED_BROADCASTS` so this process's transport carries it.
      // The worker subscribes its manifest, not `BRIDGED_CHANNELS`.
      subscriptions.push(
        bus.stream('job:queued').subscribe((event) => {
          // Every announcement received — matching or not — is stamped before
          // any filtering.
          lastQueuedEventAt = Date.now();
          // The pre-filter: the claim's `types` is the rule; this saves the
          // round trip when the announced type is one this worker cannot run.
          if (jobTypes.length > 0 && !jobTypes.includes(event.jobType)) return;
          pull();
        }),
      );

      // Reconnect is an edge into `open` after the first observation. The
      // first observation decides whether start pulls now or waits for the
      // transport to open — a claim on a closed transport would only be
      // refused locally.
      let observed = false;
      let wasOpen = false;
      subscriptions.push(
        bus.state$.subscribe((state) => {
          const open = state === 'open';
          if (observed && open && !wasOpen) pull();
          observed = true;
          wasOpen = open;
        }),
      );
      if (wasOpen) pull();
    },

    stop: () => {
      for (const s of subscriptions) s.unsubscribe();
      subscriptions = [];
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
      pull();
    },

    failJob: (jid: string, error: string) => {
      const now = Date.now();
      lastFinishedAt = now;
      lastActivityAt = now;
      activeSince = null;
      activeJob$.next(null);
      isProcessing$.next(false);
      errors$.next({ jobId: jid, error });
      pull();
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
      for (const s of subscriptions) s.unsubscribe();
      subscriptions = [];
      started = false;
      activeJob$.complete();
      isProcessing$.complete();
      jobsCompleted$.complete();
      errors$.complete();
      refused$.complete();
    },
  };
}
