/**
 * JetStreamJobQueue — the JetStream driver behind the `JobQueue` interface
 * (JOB-QUEUE-DRIVER P1, topology ruling M: gateway-mediated).
 *
 * Two primitives, one authority each:
 *
 *  - **KV bucket `jobs`** is the AUTHORITATIVE operational state: one entry
 *    per job (`{ job, lastProgressAt }`), every transition a revision-CAS —
 *    which is what makes `claimJob` atomic: simultaneous claims race on one
 *    revision and exactly one update wins.
 *  - **Stream `JOBS`** (subjects `jobs.<category>.<type>`, work-queue
 *    retention) is the DELIVERY vehicle and redelivery timer. A delivered
 *    message is the lease this process holds for a job; `working()`
 *    heartbeats extend it, and a gateway that dies stops heartbeating, so
 *    `AckWait` redelivers the job to a live instance — gateway-death
 *    recovery, protocol-native.
 *
 * Worker-death recovery is NOT AckWait's job under the mediated topology
 * (the gateway holding the lease is alive; the worker vanished): it is the
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

import { connect, RetentionPolicy, AckPolicy, DeliverPolicy, nanos } from 'nats';
import type { NatsConnection, JetStreamClient, JetStreamManager, JsMsg, KV, ConsumerMessages } from 'nats';
import type { AnyJob, PendingJob, RunningJob, FailedJob, CompleteJob, CancelledJob } from './types';
import { jobId as toJobId, type JobId, type Logger, type EventBus, type UnitCursor } from '@semiont/core';
import type { JobQueue } from './job-queue-interface';
import { willRetryAfter } from './will-retry';
import { mergeUnitCursors } from './checkpoint-merge';

const STREAM = 'JOBS';
const CONSUMER = 'gateway-claims';
const BUCKET = 'jobs';

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

export interface JetStreamJobQueueOptions {
  /** NATS server address(es), e.g. "192.168.64.42:4222". */
  servers: string | string[];
  /** Worker presumed dead after this long without progress (default 30 min). */
  staleRunningMs?: number;
  /** Lease redelivery window when THIS process stops heartbeating (default 30 s). */
  ackWaitMs?: number;
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
  private readonly lastProgressWrite = new Map<string, number>();
  private readonly staleRunningMs: number;
  private readonly ackWaitMs: number;

  constructor(
    private readonly options: JetStreamJobQueueOptions,
    private readonly logger: Logger,
    private readonly eventBus?: EventBus,
  ) {
    this.staleRunningMs = options.staleRunningMs ?? 30 * 60_000;
    this.ackWaitMs = options.ackWaitMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    this.nc = await connect({
      servers: this.options.servers,
      reconnect: this.options.reconnect ?? true,
      timeout: 10_000,
    });
    this.js = this.nc.jetstream();
    this.jsm = await this.nc.jetstreamManager();
    this.kv = await this.js.views.kv(BUCKET);

    try {
      await this.jsm.streams.info(STREAM);
    } catch {
      await this.jsm.streams.add({
        name: STREAM,
        subjects: ['jobs.>'],
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
    // after a gateway death — can only be settled by the holder, because
    // nobody else has the delivery to ack. Terminal in KV → ack and drop;
    // otherwise the lease extends. While this process is alive its leases
    // never expire; when it dies they redeliver after ackWait — that IS the
    // gateway-death recovery path.
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
  }

  destroy(): void {
    this.iter?.stop();
    this.iter = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.held.clear();
    void this.nc?.close();
  }

  /**
   * A delivery is a job arriving at this gateway. What it means depends on
   * the job's authoritative (KV) state:
   *  - pending  → hold the lease, announce for a worker to claim;
   *  - running  → hold silently (a claim raced ahead of the delivery, or a
   *               redelivery reached a fresh instance after a gateway death);
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
      this.eventBus.get('job:queued').next({
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
    // gateway already holds — the claim lands where the worker is connected.
    for (const [id, held] of [...this.held]) {
      if (!matches(held.type)) continue;
      const won = await this.tryClaim(toJobId(id));
      if (won) return won;
    }
    // Fallback: pending state whose delivery has not reached us — yet (a
    // claim racing ahead of its delivery) or ever (another gateway holds
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
