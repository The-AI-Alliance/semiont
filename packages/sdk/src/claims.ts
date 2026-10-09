/**
 * A worker's side of the job queue: `job.claim`.
 *
 * A worker is any party that takes jobs and says how each one went. What it
 * promises the dispatcher, and everyone who follows a job, is
 * docs/protocol/WORKER-CONTRACT.md; this file is that contract for
 * TypeScript, and the worker conformance suite (tests/conformance/worker)
 * holds it on the wire.
 *
 * THE MODEL. A worker asks the queue at every moment it becomes idle, and
 * never otherwise. `job:claim` carries the jobs it takes; the dispatcher
 * answers with the next pending job that matches one of them, or declines.
 * Queue state is the truth, and no message carries correctness. The idle
 * moments:
 *
 *   - its claims are first read, once the stream is open;
 *   - it settles the job it holds, immediately, with no timer;
 *   - a matching `job:queued` arrives while it holds nothing;
 *   - the stream opens again: every edge into `open` after the first.
 *
 * `job:queued` is a WAKE-UP with no memory. While the worker holds nothing it
 * causes a claim; while a claim is in flight it sets a bit that earns exactly
 * one more claim, so a wake-up cannot be lost in that window; while a job is
 * held it is ignored, because the settle claims. The check of a wake-up is a
 * PRE-FILTER: an announcement carries the job description less its input, so
 * the worker asks its own claim's question of it, `jobMatchesFilter`, the
 * comparison the dispatcher makes, and does not spend a round trip to be
 * declined.
 *
 * A HELD JOB owns its lifecycle. It says its own start, progress and
 * checkpoints, and it settles once: `complete`, `fail` and `cancel` each say
 * the outcome and release the job in one call, so a worker cannot say one
 * and forget the other.
 *
 * A HELD JOB COMMITS FOR ITSELF. `commit` sends a batch of annotations to the
 * record, citing the job, and resolves once the batch is established: the
 * record acknowledged it, or, when no acknowledgement came, answered that
 * the batch's last annotation is on the resource. The job remembers the
 * weakest of what its commits observed and states it when it settles, so a
 * worker says neither which job a batch is for nor how its commits went.
 *
 * EACH JOB HAS A TRACE OF ITS OWN (WORKER-CONTRACT T1). A claim is made in no
 * trace, whatever span is active where the idle moment came: the settle of
 * the job before it runs inside that job's span, and a claim made there would
 * put every later job in the first job's trace. The job a claim is answered
 * with is handed to its reader in the trace its reply arrived in, which is
 * the claim's own once the dispatcher has answered in it: so the span a
 * worker opens around a job, and every message the job sends, continue the
 * trace that began with its claim.
 */

import { Observable, Subject, type Subscriber, type Subscription } from 'rxjs';
import {
  BusRequestError,
  HELD_JOB_STALL_CHECK_MS,
  HELD_JOB_STALL_MS,
  JOB_CLAIM_TIMEOUT_MS,
  MARK_COMMIT_TIMEOUT_MS,
  annotationId as makeAnnotationId,
  busRequest,
  isObject,
  isString,
  jobMatchesFilter,
  replyChannelsFor,
} from '@semiont/core';
import type { Annotation, AnnotationId, BusOperationKey, BusRequestErrorCode, BusRequestPrimitive, EventMap, JobFilter, JobId, JobType, ResourceId, UnitCursor, components } from '@semiont/core';
import { getActiveTraceparent, withTraceparent, withoutTrace, type TraceCarrier } from '@semiont/observability';

/** The job a `job:claimed` reply carries, running under this worker: the spec's `JobRunning`. */
type ClaimedJob = EventMap['job:claimed']['response'];
type MarkJobResult = components['schemas']['MarkJobResult'];
type YieldJobResult = components['schemas']['YieldJobResult'];
type JobProgress = components['schemas']['JobProgress'];
type DurabilityEvidence = components['schemas']['DurabilityEvidence'];
type FailureClass = NonNullable<EventMap['job:fail']['failureClass']>;

/**
 * What a worker's stream names for its claims: the replies of `job:claim`,
 * and the two broadcasts a worker reads. `job:queued` and
 * `job:cancel-requested` reach only a stream that names them, so a transport
 * made for a worker is given these beside the reply channels of whatever
 * else the worker awaits.
 */
export const JOB_CLAIM_CHANNELS: readonly (keyof EventMap)[] = [
  ...replyChannelsFor(['job:claim']),
  'job:queued',
  'job:cancel-requested',
];

/**
 * The requests a commit makes: the commit, and the question it asks when the
 * commit goes unacknowledged.
 *
 * The question is the read of ONE annotation, and not of a resource's list
 * of them. Reply channels reach every stream that names them, and the list's
 * replies are the frames of many megabytes a worker's stream exists to keep
 * out; one annotation's frame is small.
 */
const COMMIT_OPERATIONS = ['mark:commit', 'browse:annotation-requested'] as const satisfies readonly BusOperationKey[];
type CommitOperation = (typeof COMMIT_OPERATIONS)[number];

/** What a worker's stream names for its commits: the replies of `mark:commit` and of the question it asks when one goes unacknowledged. */
export const JOB_COMMIT_CHANNELS: readonly (keyof EventMap)[] = replyChannelsFor(COMMIT_OPERATIONS);

/**
 * How weak each observation of a commit is, as evidence that the batch is on
 * the record. The two a commit is not established by are equally weak: one
 * says the record answered that the annotation is not there, the other that
 * nobody answered, and neither says more than the other.
 */
const WEAKNESS: Record<DurabilityEvidence, number> = {
  acknowledged: 0,
  'probe-confirmed': 1,
  'probe-refused': 2,
  'probe-unreachable': 2,
};

/**
 * Will this failure be put back in the queue for another attempt?
 *
 * Two places need the answer and they must never disagree: the dispatcher's
 * queue acts on it, and the worker reports it on `job:fail` as `willRetry`,
 * so a follower of the job knows whether the failure it just saw is the end.
 * Each language has one implementation, and specs/src/jobs/retry-cases.json
 * is the table all of them answer alike. The worker reads the budget off the
 * record it claimed, and `retryCount` changes only when the dispatcher fails
 * the attempt, so the two evaluations see the same numbers.
 *
 * A failure known to be deterministic skips the budget: the same request
 * cannot succeed on a second attempt. A failure of no stated class is
 * treated as transient.
 */
export function willRetryAfter(
  budget: Pick<components['schemas']['JobMetadata'], 'retryCount' | 'maxRetries'>,
  failureClass?: FailureClass,
): boolean {
  return failureClass !== 'deterministic' && budget.retryCount < budget.maxRetries;
}

export interface ClaimOptions {
  /**
   * The jobs this worker takes: the claim's `accepts`, and what a
   * `job:queued` is checked against. At least one.
   */
  accepts: JobFilter[];
  /**
   * `jobClaimTimeoutMs`, `heldJobStallMs`, `heldJobStallCheckMs` and
   * `markCommitTimeoutMs` of specs/src/client/timing.json, for a caller that
   * must not wait them out: a test, or the conformance driver. Absent, the
   * table's values stand.
   */
  jobClaimTimeoutMs?: number;
  heldJobStallMs?: number;
  heldJobStallCheckMs?: number;
  markCommitTimeoutMs?: number;
}

/**
 * A claim that was refused for a reason other than "nothing pending".
 *
 * `code` is the `BusRequestError` code the reply was promoted to, or `null`
 * when the refusal was the worker's own: a reply that names no job. Never a
 * manufactured bus code. `bus.none-pending` never appears: an empty queue is
 * not a fault. `bus.unauthorized` means this credential cannot claim, and
 * will not be able to later.
 */
export interface ClaimRefusal {
  code: BusRequestErrorCode | null;
  message: string;
}

/**
 * What a worker can say of itself at any moment (WORKER-CONTRACT V1).
 *
 * `lastQueuedEventAt` is any `job:queued` received, matching or not. On an
 * idle stack with an empty queue it stands still by design, so a still stamp
 * alone is not a fault of the stream. `lastActivityAt` (a claim, a progress
 * report, a checkpoint, a settle) is the liveness of the work: a job stuck
 * partway stops advancing it, and that is what the stall rule reads.
 */
export interface WorkerVitals {
  lastQueuedEventAt: string | null;
  lastClaimAt: string | null;
  /** The last settle, whatever its outcome: a worker that fails and moves on is alive. */
  lastFinishedAt: string | null;
  lastActivityAt: string | null;
  activeJob: { jobId: JobId; type: JobType; since: string } | null;
  jobsCompleted: number;
}

/** A held job that showed no activity for `thresholdMs` (WORKER-CONTRACT V2). What its host does then is the host's. */
export interface HeldJobStall {
  jobId: JobId;
  jobType: JobType;
  heldSince: string;
  lastActivityAt: string;
  silentForMs: number;
  thresholdMs: number;
}

/** The checkpoint a worker states: the units finished, and how far each unit begun and not finished got. */
export interface JobCheckpoint {
  completedUnits: string[];
  unitCursors?: Record<string, UnitCursor>;
}

/** What a failure carries beside its error. What the job's commits observed is the held job's own to state. */
export interface JobFailure extends Partial<JobCheckpoint> {
  /** The failure's class, when the worker knows it. */
  failureClass?: FailureClass;
}

interface Held<T extends JobType, R> {
  readonly jobId: JobId;
  readonly jobType: T;
  readonly resourceId: ResourceId;
  /** The job's parameters as the dispatcher holds them: the description, and what the dispatcher adds. */
  readonly params: ClaimedJob['params'];
  /** The units earlier attempts finished. A worker does not do them again. Empty on a first attempt. */
  readonly completedUnits: readonly string[];
  /** How far each unit begun and not finished got on an earlier attempt. Empty on a first attempt. */
  readonly unitCursors: Readonly<Record<string, UnitCursor>>;
  readonly retryCount: number;
  readonly maxRetries: number;
  /** Which attempt this is, 1-based. Every lifecycle message states it. */
  readonly attempt: number;
  /** The annotation the job is anchored to: the one a `yield` job's context is focused on. */
  readonly annotationId: AnnotationId | undefined;
  /** Aborted when a cancellation names this job. The work stops where it can, and the worker says `cancel`. */
  readonly cancelled: AbortSignal;
  /** Whether the job has been settled: completed, failed or cancelled. */
  readonly settled: boolean;

  /** `job:start`: the job's first message, said once. */
  start(): Promise<void>;
  /** `job:report-progress`. Counts as activity. */
  progress(progress: JobProgress): Promise<void>;
  /** `job:checkpoint`: what a later attempt resumes from. Counts as activity. */
  checkpoint(checkpoint: JobCheckpoint): Promise<void>;
  /** `mark:commit` for this job: resolves once the batch is established. */
  commit(resourceId: ResourceId, annotations: readonly Annotation[]): Promise<void>;
  /** Settle: `job:complete`, with the result this job's verb reports, and how its commits were established. */
  complete(result: R): Promise<void>;
  /**
   * Settle: `job:fail`. It says whether the queue will retry, from the
   * record's budget and the failure's class, and what a commit that was not
   * established observed.
   */
  fail(error: string, failure?: JobFailure): Promise<void>;
  /** Settle: `job:cancel`, once the work has stopped for a cancellation. */
  cancel(reached?: Partial<JobCheckpoint>): Promise<void>;
}

/** A `mark` job this worker holds. */
export type HeldMarkJob = Held<'mark', MarkJobResult>;
/** A `yield` job this worker holds. */
export type HeldYieldJob = Held<'yield', YieldJobResult>;
/**
 * A job this worker holds, from its claim until it settles it. Each settle
 * call says the outcome and releases the job together; a second is refused.
 * A settle the gateway did not take still releases the job, and rejects.
 */
export type HeldJob = HeldMarkJob | HeldYieldJob;

/**
 * The annotation a job is anchored to: the one a `yield` job's context is
 * focused on. A `yield` job focused on a resource has none, and neither has a
 * `mark` job.
 */
function anchorOf(jobType: JobType, params: ClaimedJob['params']): AnnotationId | undefined {
  if (jobType !== 'yield') return undefined;
  const context: unknown = params['context'];
  const focus = isObject(context) ? context['focus'] : undefined;
  if (!isObject(focus) || focus['kind'] !== 'annotation') return undefined;
  const annotation = focus['annotation'];
  return isObject(annotation) && isString(annotation['id']) ? makeAnnotationId(annotation['id']) : undefined;
}

/** What a held job's messages name it by. `job:cancel` carries this and no more. */
interface Named<T extends JobType> {
  resourceId: ResourceId;
  jobId: JobId;
  jobType: T;
  annotationId?: AnnotationId;
}

/** What a held job asks of the loop that claimed it. */
interface Holder {
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<unknown>;
  /** One of a commit's requests, awaited for `markCommitTimeoutMs`. It fails as `busRequest` fails. */
  request<Op extends CommitOperation>(operation: Op, payload: EventMap[Op]): Promise<unknown>;
  /** The work showed it is alive. */
  active(): void;
  /** `job` is settled, and no longer held. */
  released(job: { readonly jobId: JobId }, completed: boolean): void;
}

class HeldJobOf<T extends JobType, R> implements Held<T, R> {
  readonly jobId: JobId;
  readonly resourceId: ResourceId;
  readonly params: ClaimedJob['params'];
  readonly completedUnits: readonly string[];
  readonly unitCursors: Readonly<Record<string, UnitCursor>>;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly attempt: number;
  readonly annotationId: AnnotationId | undefined;
  readonly cancelled: AbortSignal;
  private readonly cancellation = new AbortController();
  private state: 'claimed' | 'begun' | 'settled' = 'claimed';
  /**
   * The weakest of what this job's commits observed, across every batch and
   * every resource it committed on: the strongest thing still true of the
   * job as a whole. None until a batch is committed, and never a default: a
   * job that commits nothing states nothing.
   */
  private durability: DurabilityEvidence | undefined;

  constructor(
    readonly jobType: T,
    claimed: ClaimedJob,
    private readonly holder: Holder,
    /** The completion this job's verb states, from what every lifecycle message carries and its result. */
    private readonly completion: (said: Named<T> & { attempt: number }, result: R) => EventMap['job:complete'],
  ) {
    const { metadata, params } = claimed;
    this.jobId = metadata.id;
    this.resourceId = params.resourceId;
    this.params = params;
    // Both appear on the record once an attempt has checkpointed. Absent, each reads as none.
    this.completedUnits = metadata.completedUnits ?? [];
    this.unitCursors = metadata.unitCursors ?? {};
    this.retryCount = metadata.retryCount;
    this.maxRetries = metadata.maxRetries;
    this.attempt = metadata.retryCount + 1;
    this.annotationId = anchorOf(jobType, params);
    this.cancelled = this.cancellation.signal;
  }

  get settled(): boolean {
    return this.state === 'settled';
  }

  /** A cancellation named this job. One that arrives after the settle signals nothing. */
  signalCancellation(): void {
    if (this.state !== 'settled') this.cancellation.abort();
  }

  private get named(): Named<T> {
    return {
      resourceId: this.resourceId,
      jobId: this.jobId,
      jobType: this.jobType,
      ...(this.annotationId ? { annotationId: this.annotationId } : {}),
    };
  }

  /** What every lifecycle message but a cancel carries. */
  private get identity(): Named<T> & { attempt: number } {
    return { ...this.named, attempt: this.attempt };
  }

  private unsettled(saying: string): void {
    if (this.state === 'settled') throw new Error(`Job ${this.jobId} is already settled: it cannot say ${saying}`);
  }

  async start(): Promise<void> {
    this.unsettled('job:start');
    if (this.state !== 'claimed') throw new Error(`job:start is a held job's first message, said once: job ${this.jobId} has already said more`);
    this.state = 'begun';
    await this.holder.emit('job:start', this.identity);
  }

  async progress(progress: JobProgress): Promise<void> {
    this.unsettled('job:report-progress');
    this.state = 'begun';
    this.holder.active();
    await this.holder.emit('job:report-progress', {
      ...this.identity,
      percentage: progress.percentage,
      progress: { ...progress, ...(this.annotationId ? { annotationId: this.annotationId } : {}) },
    });
  }

  async checkpoint(checkpoint: JobCheckpoint): Promise<void> {
    this.unsettled('job:checkpoint');
    this.state = 'begun';
    this.holder.active();
    await this.holder.emit('job:checkpoint', { jobId: this.jobId, ...checkpoint });
  }

  /**
   * Send a batch to the record and WAIT for the record to say it has it. The
   * gateway taking the message says nothing of the record: a record that is
   * down discards a batch the gateway accepted, and a job that counted the
   * batch as done would report work that never landed.
   *
   * A commit the record does not acknowledge in time is not thereby lost. If
   * the gateway goes down after the record appended the batch, the
   * acknowledgement cannot be routed, and a job failed on that would be
   * failed over annotations that are on the record. So the outcome follows
   * what the record holds, and not the arrival of a message: the record is
   * asked. A batch is never sent a second time to find out. That would double
   * the work, and where the acknowledgement was lost because the gateway is
   * down, the second commit would only time out as the first did.
   *
   * A commit that was not established fails as its unanswered request did,
   * with that request's own failure. What was observed leaves by the job's
   * settle, the one place it can still be told.
   */
  async commit(resourceId: ResourceId, annotations: readonly Annotation[]): Promise<void> {
    this.unsettled('mark:commit');
    const last = annotations.at(-1);
    // A batch of no annotations is no commit: there is nothing to establish.
    if (last === undefined) return;
    try {
      await this.holder.request('mark:commit', { resourceId, annotations: [...annotations], jobId: this.jobId });
    } catch (error) {
      // The record's refusal, and every other failure of the request, is the
      // commit's failure as it is. Only an acknowledgement that did not
      // arrive leaves what the record holds unknown.
      if (!(error instanceof BusRequestError) || error.code !== 'bus.timeout') throw error;
      const observed = await this.askWhetherRecorded(resourceId, last.id);
      this.observe(observed);
      if (observed !== 'probe-confirmed') throw error;
      return;
    }
    this.observe('acknowledged');
  }

  /**
   * Is the annotation on the resource? Asked of the LAST annotation of a
   * batch nobody acknowledged, and that is enough: the record appends a batch
   * in order and stops at the first annotation it cannot append
   * (WORKER-CONTRACT A5), so the last being there says every one before it
   * is. One question, where asking of each would be a round trip for each
   * annotation.
   *
   * Every answer but the annotation fails the commit, and the asymmetry is
   * deliberate. The record appends only the annotations it does not hold, so
   * a job retried over a batch that had landed costs one more run of the
   * batch's unit; a wrong "it is there" loses the batch silently, which is
   * what the acknowledgement exists to prevent. A question nobody answered is
   * neither yes nor no. It is said as its own observation, and it does not
   * establish the commit.
   */
  private async askWhetherRecorded(resourceId: ResourceId, annotationId: AnnotationId): Promise<Exclude<DurabilityEvidence, 'acknowledged'>> {
    try {
      await this.holder.request('browse:annotation-requested', { resourceId, annotationId });
      return 'probe-confirmed';
    } catch (error) {
      // A failure reply (`bus.rejected`) means the question was answered and
      // the answer was not the annotation. That is not "the annotation is
      // absent": a read that failed for its own reasons answers on the same
      // channel. So the job says what was observed, and its reader judges.
      // Anything else (`bus.timeout`, `bus.closed`) means nobody answered.
      // Read from the code the error carries, never by its class: a second
      // copy of @semiont/core anywhere in the tree makes a class check fail,
      // and silently, so that a refusal is said as "nobody answered", the one
      // distinction this observation exists to make.
      const code = isObject(error) && isString(error.code) ? error.code : undefined;
      return code === 'bus.rejected' ? 'probe-refused' : 'probe-unreachable';
    }
  }

  /** Remember `evidence` if it is weaker than what is remembered. Of two equally weak, the first seen is kept. */
  private observe(evidence: DurabilityEvidence): void {
    if (this.durability === undefined || WEAKNESS[evidence] > WEAKNESS[this.durability]) this.durability = evidence;
  }

  complete(result: R): Promise<void> {
    return this.settle('job:complete', true, () => ({
      ...this.completion(this.identity, result),
      ...(this.durability === undefined ? {} : { durability: this.durability }),
    }));
  }

  fail(error: string, failure: JobFailure = {}): Promise<void> {
    return this.settle('job:fail', false, () => ({
      ...this.identity,
      error,
      ...failure,
      // Stated only when a commit was not established: what is weaker than
      // any observation that establishes one. Otherwise the failure says
      // nothing of the job's commits.
      ...(this.durability !== undefined && WEAKNESS[this.durability] > WEAKNESS['probe-confirmed'] ? { durability: this.durability } : {}),
      willRetry: willRetryAfter(this, failure.failureClass),
    }));
  }

  cancel(reached: Partial<JobCheckpoint> = {}): Promise<void> {
    return this.settle('job:cancel', false, () => ({ ...this.named, ...reached }));
  }

  /**
   * Say the outcome and release the job, together. The job is settled from
   * the moment it is asked to, so a second settle is refused while the first
   * is on its way; and it is released whether or not the gateway took the
   * message, because a worker that could not say its outcome must still go on
   * claiming. The dispatcher's sweep concludes a job whose outcome never
   * arrived.
   */
  private async settle<K extends 'job:complete' | 'job:fail' | 'job:cancel'>(channel: K, completed: boolean, payload: () => EventMap[K]): Promise<void> {
    this.unsettled(channel);
    this.state = 'settled';
    try {
      await this.holder.emit(channel, payload());
    } finally {
      this.holder.released(this, completed);
    }
  }
}

/**
 * Hold the job a claim was answered with, as its verb's. Undefined for a
 * reply that names no job (WORKER-CONTRACT C9): read unguarded, one with no
 * `metadata` throws inside the loop, where no claim would ever follow, and
 * one with no id would be handed to the work as a job.
 */
function heldJob(claimed: ClaimedJob, holder: Holder): HeldJobOf<'mark', MarkJobResult> | HeldJobOf<'yield', YieldJobResult> | undefined {
  const reply: unknown = claimed;
  if (!isObject(reply) || !isObject(reply['metadata']) || !isString(reply['metadata']['id']) || !isObject(reply['params'])) return undefined;
  switch (reply['metadata']['type']) {
    case 'mark':
      return new HeldJobOf('mark', claimed, holder, (said, result: MarkJobResult) => ({ ...said, result }));
    case 'yield':
      return new HeldJobOf('yield', claimed, holder, (said, result: YieldJobResult) => ({ ...said, result }));
    default:
      return undefined;
  }
}

type AnyHeldJob = NonNullable<ReturnType<typeof heldJob>>;

/** The error of a job failed because its worker stopped, and not because the work failed. */
const STOPPED_WHILE_HELD = 'The worker stopped while it held the job';
type ClaimOutcome = { job: AnyHeldJob } | { declined: true } | { refused: ClaimRefusal };

/** One worker's claiming, from the first read of its claims until it stops. */
class ClaimLoop implements Holder {
  readonly refused$ = new Subject<ClaimRefusal>();
  readonly stalled$ = new Subject<HeldJobStall>();

  private phase: 'unread' | 'claiming' | 'stopped' = 'unread';
  private reader: Subscriber<HeldJob> | undefined;
  private subscriptions: Subscription[] = [];
  private stallCheck: ReturnType<typeof setInterval> | undefined;
  private stopping: Promise<void> | undefined;
  private held: AnyHeldJob | null = null;
  /** The held job a stall has been reported for: a stall is reported once. */
  private stallReported: AnyHeldJob | null = null;
  // The loop's two bits: one claim in flight at a time, and a wake-up that
  // arrived during it, honoured with exactly one more claim.
  private claimInFlight = false;
  private wakePending = false;
  /**
   * The trace each `job:claimed` that arrived during the claim in flight
   * arrived in, by the job it names. A frame is delivered inside the span of
   * its arrival, and the claim's answer is read after it, where that span is
   * no longer active: so the trace is kept here, at the delivery, for the
   * hand-over. By the job, because every worker's reply reaches a stream that
   * names the channel, and a job is claimed by one.
   */
  private readonly arrivedIn = new Map<string, TraceCarrier | undefined>();

  // Epoch milliseconds here; ISO in a snapshot.
  private lastQueuedEventAt: number | null = null;
  private lastClaimAt: number | null = null;
  private lastFinishedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private heldSince: number | null = null;
  private jobsCompleted = 0;

  private readonly accepts: JobFilter[];
  private readonly jobClaimTimeoutMs: number;
  private readonly heldJobStallMs: number;
  private readonly heldJobStallCheckMs: number;
  private readonly markCommitTimeoutMs: number;

  constructor(private readonly bus: BusRequestPrimitive, options: ClaimOptions) {
    this.accepts = options.accepts;
    this.jobClaimTimeoutMs = options.jobClaimTimeoutMs ?? JOB_CLAIM_TIMEOUT_MS;
    this.heldJobStallMs = options.heldJobStallMs ?? HELD_JOB_STALL_MS;
    this.heldJobStallCheckMs = options.heldJobStallCheckMs ?? HELD_JOB_STALL_CHECK_MS;
    this.markCommitTimeoutMs = options.markCommitTimeoutMs ?? MARK_COMMIT_TIMEOUT_MS;
  }

  // ── what a held job asks ─────────────────────────────────────────────────

  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<unknown> {
    return this.bus.emit(channel, payload);
  }

  request<Op extends CommitOperation>(operation: Op, payload: EventMap[Op]): Promise<unknown> {
    return busRequest(this.bus, operation, payload, this.markCommitTimeoutMs);
  }

  active(): void {
    this.lastActivityAt = Date.now();
  }

  released(job: { readonly jobId: JobId }, completed: boolean): void {
    if (this.held !== job) return;
    const now = Date.now();
    this.lastFinishedAt = now;
    this.lastActivityAt = now;
    this.heldSince = null;
    this.held = null;
    if (completed) this.jobsCompleted += 1;
    this.pull();
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  read(reader: Subscriber<HeldJob>): () => void {
    if (this.phase !== 'unread') {
      reader.error(new Error('A worker\'s claims are read once: this worker is already claiming, or has stopped'));
      return () => {};
    }
    const unnamed = JOB_CLAIM_CHANNELS.filter((channel) => !this.bus.isSubscribed(channel));
    if (unnamed.length > 0) {
      this.phase = 'stopped';
      this.refused$.complete();
      this.stalled$.complete();
      reader.error(new BusRequestError(
        `This transport's stream does not name ${unnamed.join(', ')}: a worker on it would never be answered, woken or told of a cancellation. Give the transport JOB_CLAIM_CHANNELS.`,
        'bus.unsubscribed',
        { channels: unnamed },
      ));
      return () => {};
    }
    this.phase = 'claiming';
    this.reader = reader;

    this.subscriptions.push(
      this.bus.stream('job:queued').subscribe((announced) => {
        // Every announcement received is stamped, before any filtering.
        this.lastQueuedEventAt = Date.now();
        if (this.accepts.some((filter) => jobMatchesFilter(filter, announced))) this.pull();
      }),
      // A cancellation is the held job's only when it names it.
      this.bus.stream('job:cancel-requested').subscribe((request) => {
        if (this.held !== null && request.jobId === this.held.jobId) this.held.signalCancellation();
      }),
      // Read as it comes, and not as its channel types it: a reply that names
      // no job is refused where the claim's answer is read (C9).
      this.bus.stream('job:claimed').subscribe((reply) => {
        const response: unknown = reply.response;
        const metadata = isObject(response) ? response['metadata'] : undefined;
        if (this.claimInFlight && isObject(metadata) && isString(metadata['id'])) this.arrivedIn.set(metadata['id'], getActiveTraceparent());
      }),
    );

    // The stream opening again is an edge into `open` after the first
    // observation. The first observation decides whether the first claim is
    // made now or waits for the stream to open: a claim on a closed stream
    // would only be refused here.
    let observed = false;
    let wasOpen = false;
    this.subscriptions.push(
      this.bus.state$.subscribe((state) => {
        const open = state === 'open';
        if (observed && open && !wasOpen) this.pull();
        observed = true;
        wasOpen = open;
      }),
    );

    this.stallCheck = setInterval(() => this.lookForStall(), this.heldJobStallCheckMs);

    if (wasOpen) this.pull();
    return () => void this.stop();
  }

  /** One idle moment: ask once, or remember that we were asked to. */
  private pull(): void {
    if (this.phase !== 'claiming') return;
    // Holding a job: the settle claims. Nothing to remember.
    if (this.held !== null) return;
    if (this.claimInFlight) {
      this.wakePending = true;
      return;
    }
    this.claimInFlight = true;
    this.wakePending = false;
    // In no trace: the claim, and the reading of its answer.
    withoutTrace(() => void this.claimNext().then((outcome) => {
      this.claimInFlight = false;
      const arrivedIn = 'job' in outcome ? this.arrivedIn.get(outcome.job.jobId) : undefined;
      this.arrivedIn.clear();
      if (this.phase !== 'claiming') {
        // Answered after the worker stopped: the job is this worker's at the
        // dispatcher, and nobody here will run it.
        if ('job' in outcome) void outcome.job.fail(STOPPED_WHILE_HELD).catch(() => {});
        return;
      }
      if ('job' in outcome) {
        const now = Date.now();
        this.lastClaimAt = now;
        this.lastActivityAt = now;
        this.heldSince = now;
        // A wake-up that arrived during the claim is moot: the settle claims.
        this.wakePending = false;
        this.held = outcome.job;
        // In the trace its reply arrived in.
        withTraceparent(arrivedIn, () => this.reader?.next(outcome.job));
        return;
      }
      if ('refused' in outcome) this.refused$.next(outcome.refused);
      if (this.wakePending) {
        this.wakePending = false;
        this.pull();
      }
    }));
  }

  private async claimNext(): Promise<ClaimOutcome> {
    // A claim names fields of the job description, never a job id. A reply is
    // not held to its schema here: the dispatcher states it, and its own
    // conformance suite holds every frame it sends to the channel's schema.
    // What is checked is only that the reply names a job.
    let claimed: ClaimedJob;
    try {
      claimed = await busRequest(this.bus, 'job:claim', { accepts: this.accepts }, this.jobClaimTimeoutMs);
    } catch (error) {
      if (error instanceof BusRequestError) {
        if (error.code === 'bus.none-pending') return { declined: true };
        return { refused: { code: error.code, message: error.message } };
      }
      return { refused: { code: null, message: error instanceof Error ? error.message : String(error) } };
    }
    const job = heldJob(claimed, this);
    return job ? { job } : { refused: { code: null, message: 'job:claimed names no job: it has no job id, no job type or no parameters' } };
  }

  private lookForStall(): void {
    const { held } = this;
    if (held === null || held === this.stallReported || this.lastActivityAt === null || this.heldSince === null) return;
    const silentForMs = Date.now() - this.lastActivityAt;
    if (silentForMs <= this.heldJobStallMs) return;
    this.stallReported = held;
    this.stalled$.next({
      jobId: held.jobId,
      jobType: held.jobType,
      heldSince: new Date(this.heldSince).toISOString(),
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      silentForMs,
      thresholdMs: this.heldJobStallMs,
    });
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopNow();
    return this.stopping;
  }

  private async stopNow(): Promise<void> {
    const { held } = this;
    this.phase = 'stopped';
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];
    if (this.stallCheck !== undefined) clearInterval(this.stallCheck);
    // A job held and not settled is failed, on a best-effort basis, and not
    // left for the dispatcher's sweep of running jobs. The failure states no
    // class, so the record's retry budget decides what becomes of the job.
    if (held !== null && !held.settled) await held.fail(STOPPED_WHILE_HELD).catch(() => {});
    this.refused$.complete();
    this.stalled$.complete();
    this.reader?.complete();
  }

  vitals(): WorkerVitals {
    const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());
    return {
      lastQueuedEventAt: iso(this.lastQueuedEventAt),
      lastClaimAt: iso(this.lastClaimAt),
      lastFinishedAt: iso(this.lastFinishedAt),
      lastActivityAt: iso(this.lastActivityAt),
      activeJob: this.held !== null && this.heldSince !== null
        ? { jobId: this.held.jobId, type: this.held.jobType, since: new Date(this.heldSince).toISOString() }
        : null,
      jobsCompleted: this.jobsCompleted,
    };
  }
}

/**
 * A worker's claims, from `job.claim`: each job the worker comes to hold,
 * one at a time. The next is claimed when the one held is settled.
 *
 * Claiming begins when the claims are first read (subscribed to), and they
 * are read once: one worker holds one job at a time. It ends when the reader
 * stops reading or `stop()` is called, and a job still held then is failed.
 */
export class ClaimsObservable extends Observable<HeldJob> {
  private readonly loop: ClaimLoop;

  constructor(bus: BusRequestPrimitive, options: ClaimOptions) {
    const loop = new ClaimLoop(bus, options);
    super((reader) => loop.read(reader));
    this.loop = loop;
  }

  /** Claims refused for a reason the worker's host must judge. See `ClaimRefusal`. */
  get refused$(): Observable<ClaimRefusal> {
    return this.loop.refused$.asObservable();
  }

  /** A held job that has shown no activity for `heldJobStallMs`, reported once. */
  get stalled$(): Observable<HeldJobStall> {
    return this.loop.stalled$.asObservable();
  }

  /** What this worker can say of itself now. */
  vitals(): WorkerVitals {
    return this.loop.vitals();
  }

  /**
   * Stop claiming. A job still held is failed, and this resolves once that
   * has been said, or could not be. A reader that stops reading stops the
   * claiming the same way, without waiting.
   */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}
