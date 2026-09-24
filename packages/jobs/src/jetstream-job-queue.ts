/**
 * JetStreamJobQueue — the JetStream driver behind the `JobQueue` interface
 * (JOB-QUEUE-DRIVER P1, topology ruling M: broker-mediated — the queue's own
 * process holds the broker connection and the leases; workers never touch the
 * broker. That process was the gateway; it is the dispatcher now.)
 *
 * Two primitives, one authority each:
 *
 *  - **KV bucket `jobs`** is the AUTHORITATIVE operational state: one entry
 *    per job (`{ job, lastProgressAt }`), every transition a revision-CAS —
 *    which is what makes `claimJob` atomic: simultaneous claims race on one
 *    revision and exactly one update wins. It holds LIVE jobs plus a day of
 *    concluded ones, not a history: `pruneTerminalJobs` is the retention the
 *    fs driver's janitor holds, and without it every scan over the bucket
 *    — `getStats` is one, on the metrics interval — grows forever.
 *  - **Stream `JOBS`** (subjects `jobs.<category>.<type>`, work-queue
 *    retention) is the DELIVERY vehicle and redelivery timer. A delivered
 *    message is the lease this process holds for a job; `working()`
 *    heartbeats extend it, and a dispatcher that dies stops heartbeating, so
 *    `AckWait` redelivers the job to a live instance — dispatcher-death
 *    recovery, protocol-native.
 *
 * Worker-death recovery is NOT AckWait's job under the mediated topology
 * (the dispatcher holding the lease is alive; the worker vanished): it is the
 * `lastProgressAt` sweep (`recoverStaleRunningJobs`), the same contract the
 * fs driver's mtime janitor implemented. The redelivery handler checks KV
 * state, so the two recovery paths can never double-apply.
 *
 * Battery ownership (JOB-QUEUE-DRIVER P0): the retry decision belongs to
 * `will-retry.ts` — `max_deliver` is unlimited and a deterministic failure
 * is `term()`ed, so the backend's retry engine never becomes a second
 * authority. The cursor merge belongs to `checkpoint-merge.ts`, shared with
 * every driver.
 *
 * The boundary is the point: no NATS type, subject string, or delivery
 * handle escapes this file.
 */

import { connect, NatsError, RetentionPolicy, AckPolicy, DeliverPolicy, nanos } from 'nats';
import type { NatsConnection, JetStreamClient, JetStreamManager, JsMsg, KV, ConsumerMessages } from 'nats';
import type { AnyJob, PendingJob, RunningJob, FailedJob, CompleteJob, CancelledJob } from './types';
import { jobId as toJobId, type JobId, type Logger, type EventBus, type UnitCursor } from '@semiont/core';
import { TERMINAL_JOB_RETENTION_MS, TERMINAL_JOB_SWEEP_INTERVAL_MS, type JobQueue } from './job-queue-interface';
import { willRetryAfter } from './will-retry';
import { mergeUnitCursors } from './checkpoint-merge';

const STREAM = 'JOBS';
// The durable consumer keeps its original name: it is a WIRE name on every
// deployed broker, and renaming it would orphan the consumer and its leases.
// The process that holds it is the dispatcher.
const CONSUMER = 'gateway-claims';
const BUCKET = 'jobs';
/**
 * The bucket's own backing stream and per-key subject (the NATS KV layout
 * every client shares). The retention sweep purges a concluded job at the
 * STREAM rather than through `KV.purge`, because a KV delete or purge is a
 * TOMBSTONE: it strips the value and leaves a marker message on the key's
 * subject forever. That is the same unbounded growth the sweep exists to
 * end, a thousand times cheaper — and nothing watches this bucket, so the
 * marker has no reader to notify. A stream purge by subject leaves nothing.
 *
 * Restating two wire strings is what this file is FOR (no NATS subject
 * escapes it), and they are gated rather than trusted: the retention test
 * asserts the bucket's message count, so a name that stops matching fails
 * there instead of silently purging nothing.
 */
const BUCKET_STREAM = `KV_${BUCKET}`;
const bucketSubject = (key: string) => `$KV.${BUCKET}.${key}`;

/** Minimum spacing between progress writes per job — workers can be chatty. */
const PROGRESS_WRITE_MIN_INTERVAL_MS = 5_000;

/** Bounded CAS retries: past this, something is systemically wrong. */
const MAX_CAS_ATTEMPTS = 20;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The KV record: the job plus the liveness fact the sweep reads. */
interface JobEnvelope {
  job: AnyJob;
  lastProgressAt: string;
}

/**
 * The JOBS stream's capture filter — exported as the ONE home of the fact.
 * A JetStream stream is a server-side subscription: anything published under
 * these subjects is persisted regardless of which client API produced it.
 * The signal plane's disjointness gate derives from this export instead of
 * restating it (SIGNAL-PLANE D3 gate 3).
 */
export const JOBS_STREAM_SUBJECTS = ['jobs.>'] as const;

export interface JetStreamJobQueueOptions {
  /** NATS server address(es), e.g. "192.168.64.42:4222". */
  servers: string | string[];
  /**
   * Broker credentials (INTER-COMPONENT-ACCESS P3). The same broker the signal
   * plane connects to, so the same pair. Absent means an unauthenticated
   * broker — which is what every deployment had before this, and means anyone
   * who can reach NATS can read and write the job stream.
   */
  user?: string;
  pass?: string;
  /** Worker presumed dead after this long without progress (default 30 min). */
  staleRunningMs?: number;
  /** Lease redelivery window when THIS process stops heartbeating (default 30 s). */
  ackWaitMs?: number;
  /** Re-announce + worker-death-sweep cadence (default 30 s; tests shrink it). */
  tickMs?: number;
  /** Reconnect on connection loss (default true; tests turn it off). */
  reconnect?: boolean;
}

function categoryOf(type: string): 'annotation' | 'generation' {
  return type === 'generation' ? 'generation' : 'annotation';
}

function subjectFor(job: AnyJob): string {
  return `jobs.${categoryOf(job.metadata.type)}.${job.metadata.type}`;
}

export class JetStreamJobQueue implements JobQueue {
  private nc!: NatsConnection;
  private js!: JetStreamClient;
  private jsm!: JetStreamManager;
  private kv!: KV;
  private iter: ConsumerMessages | null = null;
  /** Delivered messages this process holds — the lease, keyed by jobId,
   *  with the job's type so a by-type claim can walk them without a read. */
  private readonly held = new Map<string, { m: JsMsg; type: string }>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private tick: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lastProgressWrite = new Map<string, number>();
  private readonly staleRunningMs: number;
  private readonly ackWaitMs: number;
  private readonly tickMs: number;

  constructor(
    private readonly options: JetStreamJobQueueOptions,
    private readonly logger: Logger,
    private readonly eventBus?: EventBus,
  ) {
    this.staleRunningMs = options.staleRunningMs ?? 30 * 60_000;
    this.ackWaitMs = options.ackWaitMs ?? 30_000;
    this.tickMs = options.tickMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    this.nc = await connect({
      servers: this.options.servers,
      // The same broker as the signal plane, so the same credentials. Connect
      // options rather than a URL: this address is logged on every reconnect.
      ...(this.options.user === undefined ? {} : { user: this.options.user }),
      ...(this.options.pass === undefined ? {} : { pass: this.options.pass }),
      reconnect: this.options.reconnect ?? true,
      // For as long as the broker is unreachable: a manual broker restart is
      // the recovery, and the library's ten attempts (~20 s) closed the
      // signal plane's connection for good in its first live outage.
      maxReconnectAttempts: -1,
      timeout: 10_000,
    });
    this.watchConnection();
    this.js = this.nc.jetstream();
    this.jsm = await this.nc.jetstreamManager();
    this.kv = await this.js.views.kv(BUCKET);

    try {
      await this.jsm.streams.info(STREAM);
    } catch {
      await this.jsm.streams.add({
        name: STREAM,
        subjects: [...JOBS_STREAM_SUBJECTS],
        retention: RetentionPolicy.Workqueue,
      });
    }
    try {
      await this.jsm.consumers.info(STREAM, CONSUMER);
    } catch {
      await this.jsm.consumers.add(STREAM, {
        durable_name: CONSUMER,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: nanos(this.ackWaitMs),
        // ONE retry authority: will-retry.ts decides; the stream never
        // gives up a message on its own count.
        max_deliver: -1,
      });
    }

    const consumer = await this.js.consumers.get(STREAM, CONSUMER);
    this.iter = await consumer.consume({
      callback: (m) => {
        void this.onDelivery(m).catch((error) => {
          this.logger.warn('Job delivery handling failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });

    // The lease heartbeat doubles as RECONCILIATION (the multi-instance
    // lease-settle pin): a held delivery whose job concluded on ANOTHER
    // instance — its claim lost the CAS race, or a redelivery landed here
    // after a dispatcher death — can only be settled by the holder, because
    // nobody else has the delivery to ack. Terminal in KV → ack and drop;
    // otherwise the lease extends. While this process is alive its leases
    // never expire; when it dies they redeliver after ackWait — that IS the
    // dispatcher-death recovery path.
    this.heartbeat = setInterval(() => {
      if (this.reconciling) return;
      this.reconciling = true;
      void this.reconcileHeld()
        .catch((error) => {
          this.logger.warn('Held-lease reconciliation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.reconciling = false;
        });
    }, Math.max(250, Math.floor(this.ackWaitMs / 4)));
    this.heartbeat.unref?.();

    // The queue's periodic tick, mirroring the fs driver's internal janitor:
    //  (a) RE-ANNOUNCE held pending deliveries — INSURANCE, not dispatch. A
    //      worker pulls at every idle moment (start, settle, wake-up,
    //      reconnect), so a job created while it was busy is claimed at the
    //      settle without this tick. What this covers is a wake-up LOST in
    //      transit to an idle worker, which has nothing to settle and so
    //      nothing to pull on. On a healthy stack it never acts;
    //  (b) SWEEP for worker death (`recoverStaleRunningJobs`) — `AckWait`
    //      covers a dead GATEWAY; only this sweep covers a dead WORKER, and
    //      rows do not sweep themselves (JOB-RESTART-SAFETY P7).
    this.tick = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void (async () => {
        for (const [id, held] of [...this.held]) {
          const envelope = await this.read(toJobId(id));
          if (envelope?.job.status === 'pending') this.announce(envelope.job);
          void held;
        }
        await this.recoverStaleRunningJobs();
      })()
        .catch((error) => {
          this.logger.warn('Job-queue tick failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.ticking = false;
        });
    }, this.tickMs);
    this.tick.unref?.();

    // Retention, on its own slower clock — the fs driver's second janitor,
    // restored (`cleanupTimer` there, hourly, the same window). It is not
    // folded into the tick above because the two answer to different costs:
    // the tick must run at claim latency, a retention sweep purging a day-old
    // record is indifferent to a minute either way, and running it 120 times
    // an hour would spend a full bucket scan to find nothing 119 times.
    this.cleanupTimer = setInterval(() => {
      this.pruneTerminalJobs(TERMINAL_JOB_RETENTION_MS).catch((error) => {
        this.logger.warn('Job retention cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, TERMINAL_JOB_SWEEP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  /** An outage is never silent: one line down, one line back, one line if the client gives up. */
  private watchConnection(): void {
    const servers = this.options.servers;
    void (async () => {
      for await (const status of this.nc.status()) {
        if (status.type === 'disconnect') {
          this.logger.warn('[jobs BROKER-DOWN] NATS connection lost; queue operations fail until reconnect', { servers });
        } else if (status.type === 'reconnect') {
          this.logger.info('[jobs BROKER-RECONNECTED] NATS connection restored', { servers });
        }
      }
    })();
    // Unreachable is retried forever; refused is not. Two identical refusals
    // in a row end the client's reconnect loop whatever the attempt budget
    // says, and a broker that came back with other credentials is exactly
    // that. destroy() closes without an error.
    void this.nc.closed().then((err) => {
      if (!err) return;
      this.logger.error('[jobs BROKER-CLOSED] NATS connection closed; the client will not reconnect', {
        servers,
        reason: err instanceof NatsError ? err.code : err.message,
      });
    });
  }

  destroy(): void {
    this.iter?.stop();
    this.iter = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.held.clear();
    void this.nc?.close();
  }

  /**
   * A delivery is a job arriving at this dispatcher. What it means depends on
   * the job's authoritative (KV) state:
   *  - pending  → hold the lease, announce for a worker to claim;
   *  - running  → hold silently (a claim raced ahead of the delivery, or a
   *               redelivery reached a fresh instance after a dispatcher death);
   *  - terminal → the work already concluded elsewhere; consume the message;
   *  - unknown  → not ours to run; terminate it.
   */
  private async onDelivery(m: JsMsg): Promise<void> {
    let id: string;
    try {
      id = (JSON.parse(dec.decode(m.data)) as { jobId: string }).jobId;
    } catch {
      m.term();
      return;
    }
    const envelope = await this.read(toJobId(id));
    if (!envelope) {
      m.term();
      return;
    }
    switch (envelope.job.status) {
      case 'pending':
        this.held.set(id, { m, type: envelope.job.metadata.type });
        this.announce(envelope.job);
        break;
      case 'running':
        this.held.set(id, { m, type: envelope.job.metadata.type });
        break;
      default:
        m.ack();
        this.held.delete(id);
    }
  }

  /** Same wire shape as the fs driver: only jobs with a resourceId announce. */
  private announce(job: AnyJob): void {
    if (this.eventBus && 'params' in job && 'resourceId' in (job.params as Record<string, unknown>)) {
      this.eventBus.emit('job:queued', {
        jobId: job.metadata.id,
        jobType: job.metadata.type,
        resourceId: (job.params as { resourceId: unknown }).resourceId as never,
        userId: job.metadata.userId,
      });
    }
  }

  private async read(jobIdArg: JobId): Promise<{ job: AnyJob; lastProgressAt: string; revision: number } | null> {
    const entry = await this.kv.get(jobIdArg as string);
    if (!entry || entry.operation !== 'PUT') return null;
    const envelope = JSON.parse(dec.decode(entry.value)) as JobEnvelope;
    return { ...envelope, revision: entry.revision };
  }

  private async write(jobIdArg: JobId, envelope: JobEnvelope, revision?: number): Promise<number> {
    const payload = enc.encode(JSON.stringify(envelope));
    if (revision === undefined) return this.kv.put(jobIdArg as string, payload);
    return this.kv.update(jobIdArg as string, payload, revision);
  }

  /**
   * Read-transform-CAS with bounded retries: the transform sees the current
   * job and returns the replacement (or null to stop). Every state
   * transition goes through here, which is what makes each one atomic.
   */
  private async cas<T>(
    jobIdArg: JobId,
    transform: (job: AnyJob, lastProgressAt: string) => { envelope: JobEnvelope; result: T } | { result: T } | null,
    onMissing: T,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const current = await this.read(jobIdArg);
      if (!current) return onMissing;
      const out = transform(current.job, current.lastProgressAt);
      if (out === null) return onMissing;
      if (!('envelope' in out)) return out.result;
      try {
        await this.write(jobIdArg, out.envelope, current.revision);
        return out.result;
      } catch {
        // Revision conflict — someone else transitioned first; re-read.
      }
    }
    throw new Error(`Job ${jobIdArg} transition failed after ${MAX_CAS_ATTEMPTS} CAS attempts`);
  }

  async createJob(job: AnyJob): Promise<void> {
    const now = new Date().toISOString();
    await this.kv.create(job.metadata.id as string, enc.encode(JSON.stringify({ job, lastProgressAt: now } satisfies JobEnvelope)));
    // Only pending jobs need delivery — the stream is the claim vehicle,
    // not the record (KV is).
    if (job.status === 'pending') {
      await this.js.publish(subjectFor(job), enc.encode(JSON.stringify({ jobId: job.metadata.id })));
    }
  }

  async getJob(jobIdArg: JobId): Promise<AnyJob | null> {
    const envelope = await this.read(jobIdArg);
    return envelope?.job ?? null;
  }

  async claimNextJob(types: string[]): Promise<{ job: AnyJob } | { declined: 'none-available' }> {
    const matches = (t: string) => types.length === 0 || types.includes(t);
    // Lease-aligned fast path (topology memo, mechanic 1): deliveries this
    // dispatcher already holds — the claim lands where the worker is connected.
    for (const [id, held] of [...this.held]) {
      if (!matches(held.type)) continue;
      const won = await this.tryClaim(toJobId(id));
      if (won) return won;
    }
    // Fallback: pending state whose delivery has not reached us — yet (a
    // claim racing ahead of its delivery) or ever (another dispatcher holds
    // it; KV is the authority, and that holder's reconcile settles the
    // stale lease once this claim concludes the job).
    for (const key of await this.allKeys()) {
      const envelope = await this.read(toJobId(key));
      if (!envelope || envelope.job.status !== 'pending' || !matches(envelope.job.metadata.type)) continue;
      const won = await this.tryClaim(toJobId(key));
      if (won) return won;
    }
    return { declined: 'none-available' };
  }

  /** CAS one pending job to running; null when someone else won it. */
  private async tryClaim(jobIdArg: JobId): Promise<{ job: AnyJob } | null> {
    return this.cas<{ job: AnyJob } | null>(
      jobIdArg,
      (job) => {
        if (job.status !== 'pending') return { result: null };
        const running: RunningJob<any, any> = {
          status: 'running',
          metadata: job.metadata,
          params: job.params,
          startedAt: new Date().toISOString(),
          progress: {},
        };
        return {
          envelope: { job: running, lastProgressAt: new Date().toISOString() },
          result: { job: running as AnyJob },
        };
      },
      null,
    );
  }

  async completeJob(jobIdArg: JobId, result: Record<string, unknown>): Promise<boolean> {
    const moved = await this.cas<boolean>(
      jobIdArg,
      (job) => {
        if (job.status !== 'running') return { result: false };
        const completed: CompleteJob<any, any> = {
          status: 'complete',
          metadata: job.metadata,
          params: job.params,
          startedAt: job.startedAt,
          completedAt: new Date().toISOString(),
          result,
        };
        return { envelope: { job: completed, lastProgressAt: new Date().toISOString() }, result: true };
      },
      false,
    );
    if (moved) this.settleLease(jobIdArg, 'ack');
    return moved;
  }

  async failJob(
    jobIdArg: JobId,
    error: string,
    completedUnits?: string[],
    failureClass?: 'transient' | 'deterministic',
    unitCursors?: Record<string, UnitCursor>,
  ): Promise<'retried' | 'failed' | null> {
    const outcome = await this.cas<'retried' | 'failed' | null>(
      jobIdArg,
      (job) => {
        if (job.status !== 'running') return { result: null };
        const units = [...new Set([...(job.metadata.completedUnits ?? []), ...(completedUnits ?? [])])];
        const cursors = mergeUnitCursors(job.metadata.unitCursors, unitCursors, units);
        const metadata = {
          ...job.metadata,
          ...(units.length > 0 ? { completedUnits: units } : {}),
          ...(Object.keys(cursors).length > 0 ? { unitCursors: cursors } : {}),
        };
        if ('unitCursors' in metadata && Object.keys(cursors).length === 0) delete (metadata as { unitCursors?: unknown }).unitCursors;

        if (willRetryAfter(job.metadata, failureClass)) {
          const retried: PendingJob<any> = {
            status: 'pending',
            metadata: { ...metadata, retryCount: job.metadata.retryCount + 1 },
            params: job.params,
          };
          return { envelope: { job: retried, lastProgressAt: new Date().toISOString() }, result: 'retried' as const };
        }
        const failed: FailedJob<any> = {
          status: 'failed',
          metadata,
          params: job.params,
          startedAt: job.startedAt,
          completedAt: new Date().toISOString(),
          error,
        };
        return { envelope: { job: failed, lastProgressAt: new Date().toISOString() }, result: 'failed' as const };
      },
      null,
    );

    if (outcome === 'retried') {
      // The nak'd (or republished) delivery arrives as a fresh pending job
      // and re-announces — retry IS redelivery under this driver.
      const held = this.held.get(jobIdArg as string);
      if (held) {
        this.held.delete(jobIdArg as string);
        held.m.nak();
      } else {
        const envelope = await this.read(jobIdArg);
        if (envelope) await this.js.publish(subjectFor(envelope.job), enc.encode(JSON.stringify({ jobId: jobIdArg })));
      }
    } else if (outcome === 'failed') {
      // Deterministic or exhausted: the message must never redeliver.
      this.settleLease(jobIdArg, 'term');
    }
    return outcome;
  }

  async checkpointUnits(jobIdArg: JobId, completedUnits: string[], unitCursors?: Record<string, UnitCursor>): Promise<void> {
    await this.cas<void>(
      jobIdArg,
      (job) => {
        if (job.status !== 'running') return { result: undefined };
        const units = [...new Set([...(job.metadata.completedUnits ?? []), ...completedUnits])];
        const cursors = mergeUnitCursors(job.metadata.unitCursors, unitCursors, units);
        const metadata = { ...job.metadata, completedUnits: units } as typeof job.metadata;
        if (Object.keys(cursors).length > 0) metadata.unitCursors = cursors;
        else delete (metadata as { unitCursors?: unknown }).unitCursors;
        const updated = { ...job, metadata } as AnyJob;
        // A checkpoint is progress — it refreshes the liveness clock.
        return { envelope: { job: updated, lastProgressAt: new Date().toISOString() }, result: undefined };
      },
      undefined,
    );
  }

  async recordProgress(jobIdArg: JobId, progress: Record<string, unknown>): Promise<void> {
    const last = this.lastProgressWrite.get(jobIdArg as string) ?? 0;
    if (Date.now() - last < PROGRESS_WRITE_MIN_INTERVAL_MS) return;
    this.lastProgressWrite.set(jobIdArg as string, Date.now());

    this.held.get(jobIdArg as string)?.m.working();
    await this.cas<void>(
      jobIdArg,
      (job) => {
        if (job.status !== 'running') return { result: undefined };
        const updated: RunningJob<any, any> = {
          status: 'running',
          metadata: job.metadata,
          params: job.params,
          startedAt: job.startedAt,
          progress,
        };
        return { envelope: { job: updated, lastProgressAt: new Date().toISOString() }, result: undefined };
      },
      undefined,
    );
  }

  async cancelPendingJobs(category: 'annotation' | 'generation'): Promise<number> {
    const matches = category === 'generation'
      ? (type: string) => type === 'generation'
      : (type: string) => type.endsWith('-annotation');

    let cancelled = 0;
    for (const key of await this.allKeys()) {
      const envelope = await this.read(toJobId(key));
      if (!envelope || envelope.job.status !== 'pending' || !matches(envelope.job.metadata.type)) continue;
      const done = await this.cas<boolean>(
        toJobId(key),
        (job) => {
          if (job.status !== 'pending' || !matches(job.metadata.type)) return { result: false };
          const record: CancelledJob<any> = {
            status: 'cancelled',
            metadata: job.metadata,
            params: job.params,
            startedAt: undefined,
            completedAt: new Date().toISOString(),
          };
          return { envelope: { job: record, lastProgressAt: new Date().toISOString() }, result: true };
        },
        false,
      );
      if (done) {
        cancelled++;
        this.settleLease(toJobId(key), 'term');
      }
    }
    // Undelivered messages for the category die with the state change.
    await this.jsm.streams.purge(STREAM, { filter: `jobs.${category}.>` });
    return cancelled;
  }

  async cancelJob(jobIdArg: JobId): Promise<boolean> {
    const done = await this.cas<boolean>(
      jobIdArg,
      (job) => {
        if (job.status !== 'pending' && job.status !== 'running') return { result: false };
        const record: CancelledJob<any> = {
          status: 'cancelled',
          metadata: job.metadata,
          params: job.params,
          startedAt: job.status === 'running' ? job.startedAt : undefined,
          completedAt: new Date().toISOString(),
        };
        return { envelope: { job: record, lastProgressAt: new Date().toISOString() }, result: true };
      },
      false,
    );
    if (done) this.settleLease(jobIdArg, 'term');
    return done;
  }

  /**
   * Counts by status. The three terminal counts are the RETENTION WINDOW, not
   * lifetime totals — `pruneTerminalJobs` drops a record a day after it
   * concluded — so they answer "recently finished", never "finished ever".
   */
  async getStats(): Promise<{ pending: number; running: number; complete: number; failed: number; cancelled: number }> {
    const stats = { pending: 0, running: 0, complete: 0, failed: 0, cancelled: 0 };
    for (const key of await this.allKeys()) {
      const envelope = await this.read(toJobId(key));
      if (envelope) stats[envelope.job.status]++;
    }
    return stats;
  }

  /**
   * Worker-death recovery: the same contract the fs driver's mtime janitor
   * implemented — a running job with no progress inside the stale window is
   * retried or failed, checkpoint intact. Gateway-death recovery never comes
   * through here; that is AckWait redelivery.
   */
  async recoverStaleRunningJobs(): Promise<number> {
    const now = Date.now();
    let recovered = 0;
    for (const key of await this.allKeys()) {
      const envelope = await this.read(toJobId(key));
      if (!envelope || envelope.job.status !== 'running') continue;
      if (now - Date.parse(envelope.lastProgressAt) < this.staleRunningMs) continue;
      const outcome = await this.failJob(
        toJobId(key),
        `worker presumed dead — no progress within ${this.staleRunningMs / 60_000} minutes`,
      );
      if (outcome) {
        this.logger.warn('Recovered stale running job', { jobId: key, outcome });
        recovered++;
      }
    }
    return recovered;
  }

  /**
   * Terminal-job retention: the fs driver's hourly janitor, in this driver's
   * terms. Without it the bucket keeps every job it has ever seen, and
   * `getStats` — an OTel observable gauge, so a full bucket scan every metric
   * interval — pays for all of them forever. Measured on a live stack
   * 2026-09-24: 139 concluded records re-read every 30 seconds by a knowledge
   * base that had done very little work.
   *
   * A SWEEP AND NOT A BUCKET TTL, deliberately. `ttl` on `views.kv()` is a
   * BUCKET limit — the backing stream's `max_age` — so it expires every key
   * by age, not the terminal ones by status: a pending job nobody claimed for
   * a day, a running job whose worker went quiet, both evaporate alongside
   * the finished ones. That is not a slower version of this bug, it is a
   * worse one. This bucket is the AUTHORITATIVE record: with the entry gone
   * `read` returns null, every CAS falls through to its `onMissing`, and the
   * next delivery for that job is `term()`ed as unknown — the job disappears
   * with no failure and no trace. The rule retention needs to express is
   * about STATUS, and status is exactly what a bucket-wide clock cannot see.
   * (A per-message TTL set at the terminal write would express it, but that
   * is nats-server 2.11 plus a client that exposes it; nats.js 2.x does not.)
   *
   * Terminal is absorbing — no transition leaves `complete`/`failed`/
   * `cancelled` — so a record this sweep reads as expired cannot come back to
   * life under it, and the lease was settled at the transition that made it
   * terminal.
   */
  async pruneTerminalJobs(retentionMs: number): Promise<number> {
    const cutoff = Date.now() - retentionMs;
    let pruned = 0;
    for (const key of await this.allKeys()) {
      const envelope = await this.read(toJobId(key));
      if (!envelope) continue;
      const { job } = envelope;
      if (job.status !== 'complete' && job.status !== 'failed' && job.status !== 'cancelled') continue;
      if (Date.parse(job.completedAt) >= cutoff) continue;
      await this.jsm.streams.purge(BUCKET_STREAM, { filter: bucketSubject(key) });
      // The progress throttle outlives nothing: its entry is keyed by a job
      // that no longer exists.
      this.lastProgressWrite.delete(key);
      pruned++;
    }
    if (pruned > 0) {
      this.logger.info('Jobs cleaned up', { deletedCount: pruned });
    }
    return pruned;
  }

  /** The heartbeat body — extend live leases, settle concluded ones. */
  private async reconcileHeld(): Promise<void> {
    for (const [id, held] of [...this.held]) {
      const envelope = await this.read(toJobId(id));
      const status = envelope?.job.status;
      if (!envelope || status === 'complete' || status === 'failed' || status === 'cancelled') {
        this.held.delete(id);
        held.m.ack();
      } else {
        held.m.working();
      }
    }
  }

  /**
   * Materialize the KV key list BEFORE touching any entry: interleaving
   * `get`/`update` with an open `keys()` iterator on the same connection
   * makes the iterator drop entries (measured: the second pending job
   * vanished from every sweep until this was split into two passes).
   */
  private async allKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of await this.kv.keys()) keys.push(key);
    return keys;
  }

  /** Conclude this process's lease on a job, if it holds one. */
  private settleLease(jobIdArg: JobId, how: 'ack' | 'term'): void {
    const held = this.held.get(jobIdArg as string);
    if (!held) return;
    this.held.delete(jobIdArg as string);
    if (how === 'ack') held.m.ack();
    else held.m.term();
  }
}
