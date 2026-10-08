/**
 * Worker Process Entry Point
 *
 * One worker process serves a single software-agent identity — one
 * `(inferenceProvider, model)` pair. The client it owns is signed in
 * *as that agent* (`/api/tokens/agent`), so every event the worker emits
 * is attributed to the agent at the bus seat. Multiple
 * agents on the same host run as multiple worker processes side by
 * side; their job-claim subscriptions don't interfere because each
 * agent only subscribes to the job types its inference engine is
 * configured to serve.
 *
 * `job.claim` (`@semiont/sdk`) is the worker's side of the queue: the
 * claiming, and held jobs that say their own lifecycle and settle once
 * (docs/protocol/WORKER-CONTRACT.md). This file is the work: it runs each
 * job the claims hand out through its processor, and says how it went.
 */

import { isHeldMark, type MarkMotivation } from './types';
import type { ClaimsObservable, HeldJob, SemiontClient } from '@semiont/sdk';
import { isGenerationJobParams, getPrimaryMediaType, assembleAnnotation, findClaimSpan, capabilitiesOf, isObject, isString, jobMatchesFilter, MARK_MOTIVATIONS, type AnnotationId, type JobFilter, type JobId, type ResourceId, busRequest, BusRequestError } from '@semiont/core';

import type { InferenceClient } from '@semiont/inference';
import type { Logger, components, AssembledAnnotation, Annotation, UnitCursor } from '@semiont/core';
import { extractPdfTextLayer, type ContentReads } from '@semiont/content';
import { prepareDetection } from './workers/detection/prepare-detection';
import { classifyFailure, DeterministicJobError } from './failure-class';
import { SpanKind, recordJobOutcome, withSpan } from '@semiont/observability';
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
  buildPdfAnnotation,
  type OnProgress,
  type BuildAnnotation,
  type UnitCheckpoint,
} from './processors';

/**
 * A held `mark` job's motivation, for what names the job to an operator: a
 * message, a span, a metric's label. Undefined for a `yield` job, and for a
 * `mark` job whose params name none of the five.
 */
function motivationOf(job: Pick<HeldJob, 'jobType' | 'params'>): MarkMotivation | undefined {
  if (job.jobType !== 'mark') return undefined;
  return MARK_MOTIVATIONS.find((motivation) => motivation === job.params.motivation);
}

type Agent = components['schemas']['Agent'];
/** Derived from the spec; the wire owns this vocabulary. */
type DurabilityEvidence = components['schemas']['DurabilityEvidence'];

export interface WorkerProcessConfig {
  /**
   * The client signed in as this worker's software-agent identity. What it
   * emits is attributed to that agent, and its transport's stream names what
   * a worker's names (`WORKER_CHANNELS`).
   */
  client: SemiontClient;
  /**
   * The jobs this agent takes. Every job a worker claims runs through the
   * same inference engine — different inference engines mean different
   * agents and therefore different worker processes.
   */
  accepts: JobFilter[];
  inferenceClient: InferenceClient;
  /**
   * Test seam; defaults to `process.exit`. A claim the dispatcher refuses
   * because this credential is not a worker's can never succeed — the
   * process exits so the supervisor restarts it and the launcher's preflight
   * names the repair, instead of parking forever in silence. A held job that
   * stalls exits the same way.
   */
  exit?: (code: number) => void;
  /**
   * The agent (Software) record stamped onto annotations as `generator`
   * and onto resources as `wasAttributedTo`. Same identity that the
   * client is signed in as.
   */
  generator: Agent;
  /**
   * The resource's bytes, for the detection extraction seam. Dials the
   * Archivist rather than the gateway — which is why it rides the config
   * instead of coming off the client: the client's transport is pointed at
   * the gateway, and this read should not be.
   */
  contentReads: ContentReads;
  logger: Logger;
}

/**
 * Census declarations (`WORKER_AWAITED_OPERATIONS`, worker-runtime.ts) for the
 * three operations THIS module awaits. The claim itself is the SDK's to
 * await, and its reply channels come with `JOB_CLAIM_CHANNELS`.
 * `MarkCommitAwaits` is tied to its call by a `satisfies`; the other two have
 * no operation literal to tie to — they await through the SDK
 * (`client.browse.*(...).fresh()`), whose
 * bus-backed methods do not carry their operation in their own type, so
 * their declarations are by convention.
 */
export type MarkCommitAwaits = 'mark:commit';
export type DescriptorReadAwaits = 'browse:resource-requested';
/**
 * The durability probe: when a `mark:commit` acknowledgement times out, the
 * worker asks whether the batch's last annotation is on the resource before
 * declaring an outcome.
 *
 * Deliberately the SINGULAR read, not `browse:annotations-requested`. Reply
 * channels are global fan-out, and the annotation LIST channel is the one
 * measured at ~85 multi-MB frames/min — enough to OOM the worker, and the
 * reason `WORKER_CHANNELS` is narrow. Subscribing it to serve a rare error
 * path would undo that; one annotation's frame is small.
 */
export type DurabilityProbeAwaits = 'browse:annotation-requested';

/**
 * How long a unit's commit may take before the worker treats the sink as down.
 *
 * Generous relative to an append — the batch is one unit's annotations and the
 * Archivist may be catching up — but FINITE, which is the whole point: an
 * unbounded wait on a confirmation that never comes hangs the worker.
 */
const MARK_COMMIT_TIMEOUT_MS = 60_000;

/**
 * Persist a batch of annotations and WAIT for the event log to confirm it:
 * `mark:commit` replies only once the batch is in the log, and nothing counts
 * as complete before that.
 *
 * Every worker path that mints annotations goes through here. `mark:create` is
 * fire-and-forget: its emit resolves when the gateway accepts the frame, which
 * says nothing about the Stower having appended anything — so on that path a
 * down Archivist discards a job's whole output while the job reports success.
 * The emit timeout (`EMIT_TIMEOUT_MS`) stops such a path HANGING; only the
 * acknowledgement stops it LOSING.
 *
 * Empty is a no-op, not a round trip: a job that found nothing has nothing to
 * make durable, and the caller still proceeds.
 */
async function commitAnnotations(
  client: SemiontClient,
  resourceId: ResourceId,
  annotations: readonly { readonly id: AnnotationId }[],
  jobId: JobId,
): Promise<DurabilityEvidence | undefined> {
  if (annotations.length === 0) return undefined;
  try {
    await busRequest(
      client.transport,
      'mark:commit' satisfies MarkCommitAwaits,
      // The batch cites the job it fulfils. Who asked for these annotations is
      // derived downstream from that job's own events; the worker never says.
      { resourceId, annotations, jobId },
      MARK_COMMIT_TIMEOUT_MS,
    );
    return 'acknowledged';
  } catch (error) {
    if (!(error instanceof BusRequestError) || error.code !== 'bus.timeout') throw error;
    const evidence = await probeDurability(client, resourceId, annotations);
    // The batch is in the log; only the acknowledgement was lost. Returning
    // success here is the point of the probe — see `probeDurability`.
    if (evidence === 'probe-confirmed') return evidence;
    // Not established. The failure carries WHAT WAS OBSERVED out to the
    // terminal record, which is the only place it can still be told.
    throw new CommitDurabilityError(error.message, evidence, error);
  }
}

/**
 * A commit that could not be established as durable, carrying the observation
 * out to `job:fail`.
 *
 * Subclasses nothing meaningful on purpose: `classifyFailure` recognises
 * neither this nor the `BusRequestError` it wraps, so both land `undefined` —
 * retryable. The message is the wrapped error's, so the persisted `error`
 * string is the same with or without the wrapper; this adds evidence beside
 * it rather than replacing it.
 */
export class CommitDurabilityError extends Error {
  override readonly name = 'CommitDurabilityError';
  constructor(message: string, readonly durability: DurabilityEvidence, cause: unknown) {
    super(message, { cause });
  }
}

/**
 * Did the batch land?
 *
 * A lost `mark:commit-ok` says nothing about the event log: if the gateway
 * goes down after a batch is appended, the ack cannot route, and without the
 * probe the job reports FAILED over durable data — indistinguishable, to a
 * user, from having produced nothing. The outcome must follow the durable
 * fact, not the arrival of a message.
 *
 * Only the LAST annotation is probed, and that is sufficient rather than
 * approximate: `handleMarkCommit` appends a batch strictly in order and stops
 * at the first failure (`stower.ts`, pinned by
 * `stower-commit-idempotence.test.ts`), so the last id being present means every
 * earlier one is too. Probing all of them would be a round trip per
 * annotation; probing the list channel would subscribe the frames that OOM
 * the worker (see `DurabilityProbeAwaits`).
 *
 * Every non-answer — `'probe-refused'`, `'probe-unreachable'` — fails the
 * commit, which retries, and that asymmetry is deliberate. `mark:commit`
 * appends only the annotations the log does not already hold, so a needless
 * retry costs one re-run of the unit; a wrong `'probe-confirmed'` loses the
 * whole unit silently, which is the false success the acknowledgement
 * exists to prevent. An unreachable probe is neither yes nor no: it is a
 * third, INDETERMINATE state, named as such in the evidence and treated as
 * failure by the caller.
 */
async function probeDurability(
  client: SemiontClient,
  resourceId: ResourceId,
  annotations: readonly { readonly id: AnnotationId }[],
): Promise<Exclude<DurabilityEvidence, 'acknowledged'>> {
  const last = annotations[annotations.length - 1];
  if (!last) return 'probe-unreachable';
  try {
    await client.browse
      .annotation(resourceId, last.id)
      .fresh();
    return 'probe-confirmed';
  } catch (error) {
    // A failure REPLY (`bus.rejected`) means the read was answered and did not
    // produce the annotation. That is not the same as "the annotations are
    // absent" — a read that threw for its own reasons answers on the same
    // channel — so the record says what was observed and lets the reader judge.
    // Anything else (`bus.timeout`, `bus.closed`) means nobody answered.
    // Discriminated STRUCTURALLY, on the code the error carries, not by
    // `instanceof`: a second copy of @semiont/core anywhere in the tree makes
    // the prototype check fail, and it would fail SILENTLY — degrading a
    // refusal into "unreachable", which is the one distinction this field
    // exists to make. (`vi.resetModules` produces exactly that.)
    const code = isObject(error) && isString(error.code) ? error.code : undefined;
    return code === 'bus.rejected' ? 'probe-refused' : 'probe-unreachable';
  }
}

/**
 * Claim the jobs `config.accepts` describes and run each one. The claims are
 * returned for their vitals, and to be stopped.
 */
export function startWorkerProcess(config: WorkerProcessConfig): ClaimsObservable {
  const { client, logger } = config;
  const claims = client.job.claim({ accepts: config.accepts });

  // What a refused claim means to this process. `bus.none-pending` never
  // arrives here (an empty queue is not a fault). `bus.unauthorized` is a
  // verdict about this credential — retrying cannot change it — so the
  // process exits for restart rather than parking forever with nothing in
  // its own logs saying why. Everything else is logged and the worker stays
  // parked until the next wake-up, which retries.
  const exit = config.exit ?? ((code: number) => process.exit(code));
  claims.refused$.subscribe(({ code, message }) => {
    if (code === 'bus.unauthorized') {
      logger.error('Claim refused: this worker is not authorized to claim jobs — exiting for restart', {
        code, message, accepts: config.accepts,
      });
      exit(1);
      return;
    }
    logger.warn('Claim declined; parked until the next wake-up', { code, message });
  });

  // Checkpointed resume: units a reference run completes are accumulated
  // here so the failure path can carry them on job:fail — the queue records
  // them and a retry skips them. Shared between handleJob (which fills it)
  // and the catch below (which reads it); cleared on every terminal outcome.
  const completedUnitsByJob = new Map<string, string[]>();

  // The mid-unit half of the same checkpoint: the cursor each unfinished unit
  // reached. Kept beside `completedUnitsByJob` and for the same reason:
  // `job:fail` is the clean-failure path, and without this a job that dies
  // partway through its only unit reports a checkpoint that says nothing
  // happened.
  const unitCursorsByJob = new Map<string, Record<string, UnitCursor>>();

  // A held job that shows no activity is wedged: every announcement is
  // ignored while a job is held, and the settle is what claims, so a worker
  // that never settles never recovers on its own. Silent hang, loud crash,
  // and whatever restart policy the deployment chose. The threshold and the
  // check are rows of specs/src/client/timing.json, with no env knobs, and
  // sit between two other lines: the inference timeout fires first, and the
  // dispatcher's sweep of running jobs concludes the job regardless. That
  // sweep is the guarantee: this check is an in-process timer, and cannot
  // fire while the event loop itself is blocked.
  claims.stalled$.subscribe((stall) => {
    logger.error('Worker stalled — exiting for restart', {
      agent: config.generator['@id'],
      jobId: stall.jobId,
      jobType: stall.jobType,
      processingSince: stall.heldSince,
      lastActivityAt: stall.lastActivityAt,
      silentForMs: stall.silentForMs,
      thresholdMs: stall.thresholdMs,
    });
    exit(1);
  });

  claims.subscribe({
    next: (job) => {
      logger.info('Processing job', { jobId: job.jobId, type: job.jobType, resourceId: job.resourceId });
      // Cooperative cancellation: a cancellation that names the held job
      // aborts its signal; the reference loop stops at its next unit boundary
      // and the job moves to cancelled/ carrying its checkpoint — no worker
      // kill. A pending job's cancel is handled by the dispatcher; a running
      // job's must be cooperative, or it would be yanked out from under a
      // live worker (the roach-motel race).
      job.cancelled.addEventListener('abort', () => {
        logger.info('Cancel requested for active job — stopping at next unit boundary', { jobId: job.jobId });
      }, { once: true });
      handleJob(config, job, completedUnitsByJob, unitCursorsByJob)
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          // Classify HERE, while the error is still typed — on the wire it is
          // only a string (taxonomy in failure-class.ts).
          const failureClass = classifyFailure(error);
          logger.error('Job failed', { jobId: job.jobId, error: message, failureClass, stack: error instanceof Error ? error.stack : undefined });
          // A settle the gateway did not take has released the job already,
          // and there is nothing more this worker can say of it.
          if (job.settled) return;
          const completedUnits = completedUnitsByJob.get(job.jobId);
          const unitCursors = unitCursorsByJob.get(job.jobId);
          // `job.fail` states `willRetry`: whether this failure is the END,
          // answered by the same table the queue applies. Without it a
          // follower cannot tell a recovering run from a dead one.
          await job.fail(message, {
            ...(completedUnits && completedUnits.length > 0 ? { completedUnits } : {}),
            // Where each unfinished unit got to. Absent rather than `{}` when
            // nothing was reached: an empty object would claim units were
            // tracked and none progressed.
            ...(unitCursors && Object.keys(unitCursors).length > 0 ? { unitCursors } : {}),
            ...(failureClass !== undefined ? { failureClass } : {}),
            // What the commit path OBSERVED about durability, when the failure
            // came from a commit at all. Present only on that path: absent means
            // the question never arose, never that durability was ruled out.
            ...(error instanceof CommitDurabilityError ? { durability: error.durability } : {}),
          });
        })
        // The failure itself could not be said. The job is released, and the
        // dispatcher's sweep concludes it.
        .catch((error: unknown) => {
          logger.error('Job failure could not be reported', { jobId: job.jobId, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          completedUnitsByJob.delete(job.jobId);
          unitCursorsByJob.delete(job.jobId);
        });
    },
    // The transport's stream does not name what a worker's must: nothing
    // would ever wake this worker, so it does not stay up.
    error: (error: unknown) => {
      logger.error('Cannot claim jobs — exiting for restart', { error: error instanceof Error ? error.message : String(error) });
      exit(1);
    },
  });

  return claims;
}

// Exported for unit testing — the orchestration (claim→fetch→process→emit→complete)
// is the only thing not otherwise exercised by processors.test.ts.
// Do not call from outside the worker process.
export async function handleJob(
  config: WorkerProcessConfig,
  job: HeldJob,
  // The subscription in startWorkerProcess passes its shared accumulator so
  // the failure path can read what the reference branch committed
  // (checkpointed resume); standalone callers may omit it — a fresh map
  // changes no behavior, only discards the checkpoint on return.
  completedUnitsByJob: Map<string, string[]> = new Map(),
  // The mid-unit half of the checkpoint, same sharing rule as
  // `completedUnitsByJob`: filled here, read by the failure path.
  unitCursorsByJob: Map<string, Record<string, UnitCursor>> = new Map(),
): Promise<void> {
  const start = performance.now();
  const motivation = motivationOf(job);
  let outcome: 'completed' | 'failed' = 'completed';
  try {
    return await withSpan(
      `job:${job.jobType}`,
      () => handleJobInner(config, job, completedUnitsByJob, unitCursorsByJob),
      {
        kind: SpanKind.CONSUMER,
        attrs: {
          'job.type': job.jobType,
          ...(motivation ? { 'job.motivation': motivation } : {}),
          'job.id': job.jobId,
          'resource.id': job.resourceId,
        },
      },
    );
  } catch (err) {
    outcome = 'failed';
    throw err;
  } finally {
    recordJobOutcome({ jobType: job.jobType, ...(motivation ? { motivation } : {}) }, outcome, performance.now() - start);
  }
}

async function handleJobInner(
  config: WorkerProcessConfig,
  job: HeldJob,
  completedUnitsByJob: Map<string, string[]>,
  unitCursorsByJob: Map<string, Record<string, UnitCursor>> = new Map(),
): Promise<void> {
  const { client, inferenceClient, generator } = config;
  // Who asked for the job is not among what the worker holds: it cites the
  // job, and the Stower derives the requester from the dispatcher's record of
  // it — provenance is derived, never asserted.
  const { jobId, jobType, resourceId, params } = job;
  // What this job is, as a claim or a config section names it, for a message.
  const what = jobType === 'mark' ? `mark (${motivationOf(job) ?? 'no motivation'})` : jobType;
  // Aborted when a cancellation names this job; the reference loop stops at
  // its next unit boundary and the job moves to cancelled/.
  const signal = job.cancelled;

  // ── Job lifecycle signaling ───────────────────────────────────────────
  // The held job says its own lifecycle (`job.start`, `job.progress`,
  // `job.checkpoint`, and one of `job.complete`, `job.fail`, `job.cancel`),
  // each globally, with the job's identity, its attempt, and the annotation a
  // generation job is anchored to. Start, complete and fail are recorded by
  // the Stower; progress is passed on and not recorded.

  // What this job's commits ESTABLISHED, folded across every batch it makes
  // (a reference job commits per unit; generation commits on two resources).
  // Weakest wins: one batch rescued by the probe makes the whole completion a
  // probe-confirmed claim, because that is the strongest thing still true of
  // the job as a whole. Undefined until a batch actually commits — a job that
  // mints nothing states nothing.
  let durability: DurabilityEvidence | undefined;
  const record = (evidence: DurabilityEvidence | undefined) => {
    if (evidence === undefined) return;
    if (durability === undefined || durability === 'acknowledged') durability = evidence;
  };
  /** What this job's commits established, as a settle states it. A job that committed nothing states nothing. */
  const established = () => (durability ? { durability } : {});

  await job.start();

  if (!config.accepts.some((filter) => jobMatchesFilter(filter, { jobType, params }))) {
    // The dispatcher hands out only what the claim accepts, so this is a job
    // the two disagree about. No second attempt changes what this worker is
    // configured for, so it skips the retry budget: thrown, the caller fails
    // the held job on the wire. A job only released here would stay `running`
    // until the dispatcher's sweep.
    throw new DeterministicJobError(`Worker not configured for job: ${what}`);
  }

  // Detection needs the resource's text plus a media-appropriate way to anchor a
  // detected span. Both come from `prepareDetection`, which reads a resource
  // by the same media-type text source the Smelter embeds from — so a resource
  // that can be embedded can be detected over, scanned PDFs included.
  //
  // Two failures, deliberately distinguished. A media type with no extractor at
  // all ('none' — a zip, an image) can never yield text, so asking to detect
  // over it is a user error and throws (surfaces as job:fail). A resource whose
  // extraction *failed* — encrypted, corrupt, a scan OCR could not read —
  // declines cleanly and completes the job saying which. Generation reads the
  // annotation in its params, not the source bytes, so it is not prepared here.
  let ready: { text: string; buildAnnotation: BuildAnnotation } | null = null;
  if (job.jobType === 'mark') {
    const descriptor = await client.browse.resource(resourceId).fresh();
    const mediaType = getPrimaryMediaType(descriptor);
    // Its own span: extraction (fetch + decode, or a multi-second OCR pass on
    // a scanned PDF) is otherwise indistinguishable from inference in a
    // trace.
    const source = await withSpan(
      'detection:prepare',
      () => prepareDetection(mediaType ?? '', config.contentReads, resourceId, generator, (rid) => client.browse.resourceAnchoredText(rid)),
      { attrs: { 'resource.id': resourceId as unknown as string, 'media.type': mediaType ?? 'unknown' } },
    );

    if ('declined' in source) {
      if (source.declined === 'not-yet') {
        // The Smelter has not finished deriving this resource's anchored text.
        // Not an error — the work is not ready. Throw a TRANSIENT failure
        // (classifyFailure leaves it unrecognized → transient) so the job
        // retries and the retry finds the store warm. NEVER OCR here: the
        // Smelter is the sole producer.
        throw new Error(`Anchored text not yet derived for resource ${resourceId} — Smelter has not settled; retrying`);
      }
      if (source.declined === 'no-extractor') {
        // A media type with nothing to extract is a user error, not weather —
        // retrying cannot change it, so it skips the retry budget.
        throw new DeterministicJobError(`Cannot run ${what} on resource ${resourceId}: media type '${mediaType ?? 'unknown'}' has no extractable text to analyze`);
      }
      if (source.declined === 'no-map' || source.declined === 'unknown') {
        // Terminal, and loud: no-map is drift between `yieldsGeometryOf` and the
        // Smelter's skip decision (a geometry type it declined to map); unknown
        // is a resource with no content identity. Neither is retryable, and
        // both mean something upstream is wrong — surface it, do not complete
        // as if the resource simply had nothing to detect.
        throw new DeterministicJobError(`Cannot run ${what} on resource ${resourceId}: anchored-text consult returned '${source.declined}'`);
      }
      // A genuine content decline (encrypted, corrupt, scanned-without-OCR,
      // empty) — the resource legitimately has nothing to detect over. A clean
      // completion carrying the reason, not a failure.
      await job.complete({ declined: true, reason: source.declined }, established());
      return;
    }
    ready = source;
  }

  const onProgress: OnProgress = (percentage, message, extra) => {
    // Progress doubles as the worker's liveness heartbeat: the held job
    // counts it as activity, which is what the stall rule reads, and the
    // dispatcher's sweep of running jobs reads the report itself.
    //
    // `message` is a code plus typed params, forwarded verbatim — the
    // producer says WHAT happened and every client renders it in its own
    // language. No sentence is composed anywhere on this path.
    job.progress({ percentage, message, ...(extra ?? {}) }).catch(() => {});
  };

  /**
   * Per-unit resume positions for THIS attempt, reported on every checkpoint
   * and carried onto a terminal failure. In-memory only: the durable copy is
   * the queue's, merged monotonically, because two checkpoints can be in
   * flight and the older can land last.
   */
  const unitCursors = new Map<string, UnitCursor>();

  /**
   * Commit a chunk's annotations, then record where that leaves its unit.
   *
   * The order is the contract — the checkpoint must never lead the log — and
   * it is enforced by being ONE step rather than two callbacks a caller has to
   * sequence correctly. A commit that throws checkpoints nothing, so the retry
   * re-runs that chunk into a log that dedupes it by id.
   */
  const commitChunk = async (annotations: Annotation[], checkpoint: UnitCheckpoint) => {
    record(await commitAnnotations(client, resourceId, annotations, jobId));
    unitCursors.set(checkpoint.unit, checkpoint.cursor);
    // Published to the caller's accumulator as it moves: the failure path runs
    // OUTSIDE this function, so a cursor only this scope knows about would be
    // lost on exactly the failures it exists to survive.
    unitCursorsByJob.set(job.jobId, Object.fromEntries(unitCursors));
    await job.checkpoint({
      completedUnits: [...(completedUnitsByJob.get(job.jobId) ?? [])],
      unitCursors: Object.fromEntries(unitCursors),
    });
  };

  if (job.jobType === 'mark' && isHeldMark(params, 'highlighting')) {
    const { result } = await processHighlightJob(
      ready!.text, inferenceClient, params, ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit, so
      // a partway unit resumes at its offset instead of the top. Empty on a
      // first attempt.
      job.unitCursors,
    );
    await job.complete(result, established());

  } else if (job.jobType === 'mark' && isHeldMark(params, 'commenting')) {
    const { result } = await processCommentJob(
      ready!.text, inferenceClient, params, ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    );
    await job.complete(result, established());

  } else if (job.jobType === 'mark' && isHeldMark(params, 'assessing')) {
    const { result } = await processAssessmentJob(
      ready!.text, inferenceClient, params, ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    );
    await job.complete(result, established());

  } else if (job.jobType === 'mark' && isHeldMark(params, 'linking')) {
    // Checkpointed resume. A retried claim skips the units earlier attempts
    // completed; every remaining unit commits chunk by chunk through
    // `commitChunk`, and the unit callback checkpoints it once its last chunk
    // has committed — the awaited commits ARE the acceptance that lets the
    // unit count as complete, and the accumulator feeds the job:fail payload
    // if a later unit dies.
    const skip = new Set(job.completedUnits);
    const remaining = {
      ...params,
      entityTypes: params.entityTypes.filter((t) => !skip.has(String(t))),
    };
    const committed: string[] = [];
    completedUnitsByJob.set(job.jobId, committed);

    const { result } = await processReferenceJob(
      ready!.text, inferenceClient, remaining, ready!.buildAnnotation, onProgress, config.logger,
      async (unit) => {
        // By the time this fires, every chunk of the unit has committed
        // through the awaited callback below — the checkpoint trails the log,
        // never leads it. Durable so a crashed worker's retry skips the unit
        // (the janitor recovers a job that already records it); the in-memory
        // `committed` still feeds the job:fail payload on a clean failure. A
        // unit failing mid-stream never reaches here; its landed chunks
        // re-commit on retry into a log that dedupes by id.
        committed.push(unit);
        // The unit is done, so it is no longer partway: dropping it keeps the
        // reported payload consistent with what the queue stores, which treats
        // the two sets as disjoint.
        unitCursors.delete(unit);
        unitCursorsByJob.set(job.jobId, Object.fromEntries(unitCursors));
        await job.checkpoint({
          completedUnits: [...committed],
          ...(unitCursors.size > 0 ? { unitCursors: Object.fromEntries(unitCursors) } : {}),
        });
      },
      signal,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    );
    // Cooperative cancellation: the loop stopped because a cancel was
    // requested for this job. Announce it so the queue moves the
    // (still-running) job to cancelled/ — never yanked out from under this
    // worker — carrying the units it did finish (already checkpointed above).
    // A cancel is a clean terminal, not a failure.
    if (signal.aborted) {
      await job.cancel(committed.length > 0 ? { completedUnits: [...committed] } : {});
      return;
    }
    await job.complete(result, established());

  } else if (job.jobType === 'mark' && isHeldMark(params, 'tagging')) {
    const { result } = await processTagJob(
      ready!.text, inferenceClient, params, ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    );
    await job.complete(result, established());

  } else if (job.jobType === 'yield') {
    // Trust-boundary narrowing: params crossed the wire as untyped JSON. The
    // guard checks the schema's required trio; a malformed bag fails the job
    // loudly here instead of surfacing as a mid-generation TypeError.
    if (!isGenerationJobParams(job.params)) {
      throw new Error(
        `generation job ${job.jobId}: params do not satisfy GenerationJobParams `
        + `(title, storageUri, and context are required)`,
      );
    }
    const genResult = await processGenerationJob(
      inferenceClient, job.params, onProgress, config.logger,
    );

    // Content never travels on the bus. Upload via the http-transport's
    // `client.yield.resource()` — same serializer the /know/compose
    // page uses, so the multipart wire shape has ONE definition.
    // The Archivist writes content to disk and records the resource
    // (`yield:create`); we only learn the new resourceId from the response.
    // Annotation-focus generation auto-binds to the triggering reference: the
    // annotation the job is anchored to, which the held job derives from the
    // context's focus (the wire does not carry it).
    const genReferenceId = job.annotationId;

    // The Save location the user typed is AUTHORITATIVE and there is no
    // fallback. Deriving one from the title would put the artifact at
    // file://<title-slug><ext>, so renaming the title would MOVE THE FILE; a
    // `||` fallback would only hide a caller that forgot. The guard above
    // rejects an absent OR empty uri, so by here it is a real location.
    const storageUri = job.params.storageUri;

    // Faithful and incurious: the worker writes the requested bytes to
    // the requested URI and does NOT police the pair — a mismatch is a
    // user-intent question the form answers earlier and better, so refusing
    // here would turn a typo into a job failure discovered minutes later.
    // Deliberately NOT the `outputMediaType` precedent, which guards an
    // invariant only the worker can check.
    const expectedExtension = capabilitiesOf(genResult.format)?.extension;
    if (expectedExtension && !storageUri.toLowerCase().endsWith(expectedExtension)) {
      config.logger.warn('Storage URI extension does not match the generated format — writing it as requested', {
        jobId, storageUri, format: genResult.format, expectedExtension,
      });
    }

    const { resourceId: newResourceId } = await client.yield.resource({
      name: genResult.title,
      file: Buffer.from(genResult.content),
      format: genResult.format,
      storageUri,
      sourceResourceId: resourceId as unknown as string,
      ...(genReferenceId ? { sourceAnnotationId: genReferenceId } : {}),
      ...(job.params.prompt ? { generationPrompt: job.params.prompt } : {}),
      ...(job.params.language ? { language: job.params.language } : {}),
      ...(job.params.entityTypes && job.params.entityTypes.length > 0 ? { entityTypes: job.params.entityTypes } : {}),
      generator,
      // The resource cites the job it fulfils; who asked for it is derived
      // downstream from that job's events, never stated here.
      jobId,
    });

    // Resource-focus generation has no triggering reference — mint a navigable
    // source→derived reference annotation so the derivation is a first-class
    // edge, targeting the whole source resource (resource-level, no selector).
    // Annotation-focus generation instead auto-binds the triggering reference
    // via `sourceAnnotationId` on the upload above.
    if (!genReferenceId) {
      const { annotation: provenanceRef } = assembleAnnotation(
        {
          motivation: 'linking',
          target: { source: resourceId },
          body: { type: 'SpecificResource', source: newResourceId, purpose: 'linking' },
        },
        generator,
      );
      record(await commitAnnotations(client, resourceId, [provenanceRef], jobId));
    }

    // Inline citations: mint each as a linking annotation ON THE DERIVED
    // resource — the target anchors the claim, the body points at the cited
    // source — so citations are first-class references like any other.
    //
    // Anchoring branches on the artifact's anchoring model. Text formats
    // anchor by character offset into the DECODED text — consumers apply
    // selectors to the decoded string, not raw bytes. A PDF anchors by PAGE
    // GEOMETRY: the citation's offsets index the Typst SOURCE and would
    // render nothing, so each claim is re-found in the artifact's own text
    // layer (two-stage search — strict, then break-aware for hyphenation) and
    // located to rects. A claim the search cannot find is dropped LOUDLY,
    // never minted wrong.
    // Collected, then committed once: the citations all land on the DERIVED
    // resource, so they are one batch keyed by `newResourceId` — a different
    // resource from the provenance edge above, which is why they cannot share
    // a commit.
    const citationRefs: AssembledAnnotation['annotation'][] = [];
    if (genResult.format === 'application/pdf' && genResult.citations.length > 0) {
      const layer = await extractPdfTextLayer(genResult.content);
      if (!layer) {
        config.logger.warn('PDF citations dropped — the generated artifact yielded no text layer', {
          jobId, resourceId: newResourceId, citations: genResult.citations.length,
        });
      } else {
        for (const citation of genResult.citations) {
          const span = findClaimSpan(layer, citation.exact);
          if (!span) {
            config.logger.warn('PDF citation dropped — claim not found in the rendered text layer', {
              jobId, resourceId: newResourceId, citedResourceId: citation.resourceId,
              exactPreview: citation.exact.slice(0, 80),
            });
            continue;
          }
          // The quote must be the RENDERED substring, not the source claim:
          // hyphenation drops characters, so the source string can fail
          // buildPdfAnnotation's containment invariant even though the span
          // was found — and W3C-wise the quote should be the text actually
          // under the rects, which is what re-anchoring will see.
          const citationRef = buildPdfAnnotation(
            layer,
            newResourceId,
            generator,
            'linking',
            { exact: layer.text.slice(span.start, span.end), start: span.start, end: span.end },
            { type: 'SpecificResource', source: citation.resourceId, purpose: 'linking' },
          );
          citationRefs.push(citationRef);
        }
      }
    } else {
      for (const citation of genResult.citations) {
        const { annotation: citationRef } = assembleAnnotation(
          {
            motivation: 'linking',
            target: {
              source: newResourceId,
              selector: [
                { type: 'TextPositionSelector', start: citation.start, end: citation.end },
                { type: 'TextQuoteSelector', exact: citation.exact },
              ],
            },
            body: { type: 'SpecificResource', source: citation.resourceId, purpose: 'linking' },
          },
          generator,
        );
        citationRefs.push(citationRef);
      }
    }

    record(await commitAnnotations(client, newResourceId, citationRefs, jobId));

    await job.complete({ resourceId: newResourceId, resourceName: genResult.title, truncated: genResult.truncated }, established());

  } else {
    // A job this worker claims and cannot run: a tagging job handed over
    // without the schema the Dispatcher resolves, say. A second attempt
    // would be handed the same job, so it skips the retry budget.
    throw new DeterministicJobError(`No processor for job: ${what}`);
  }
}
