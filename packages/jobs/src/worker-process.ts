/**
 * Worker Process Entry Point
 *
 * One worker process serves a single software-agent identity — one
 * `(inferenceProvider, model)` pair. The session it owns is
 * authenticated *as that agent* (`/api/tokens/agent`), so every event
 * the worker emits attributes to the agent at the bus seat. Multiple
 * agents on the same host run as multiple worker processes side by
 * side; their job-claim subscriptions don't interfere because each
 * agent only subscribes to the job types its inference engine is
 * configured to serve.
 *
 * `createJobClaimAdapter` handles the reactive contract (SSE
 * subscription, claim, completion tracking). This file wires the
 * job processors to the adapter and drives lifecycle emissions.
 */

import { createJobClaimAdapter, type JobClaimAdapter, type ActiveJob } from './job-claim-adapter';
import { willRetryAfter } from './will-retry';
import {
  asJobParams,
  isJobType,
  type AssessmentDetectionParams,
  type CommentDetectionParams,
  type DetectionParams,
  type HighlightDetectionParams,
  type JobType,
  type TagDetectionParams,
} from './types';
import type { SemiontSession } from '@semiont/sdk';
import { type HttpTransport } from '@semiont/http-transport';
import { isGenerationJobParams, getPrimaryMediaType, assembleAnnotation, resourceId as makeResourceId, annotationId as makeAnnotationId, findClaimSpan, capabilitiesOf, isObject, isString, type EventMap, busRequest, BusRequestError } from '@semiont/core';

import type { InferenceClient } from '@semiont/inference';
import type { Logger, components, AssembledAnnotation, Annotation, UnitCursor } from '@semiont/core';
import { workerBusAsPrimitive } from './worker-bus-primitive.js';
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
 * The ONE derivation for a job's associated reference/annotation id
 * (GENERATION-WIRE-CONTEXT D3). Generation params no longer carry
 * `referenceId` on the wire — the context's focus is authoritative — so for
 * generation jobs the id comes from `focus.annotation.id` (annotation focus)
 * or is undefined (resource focus). Non-generation jobTypes (detection
 * echoes) keep their own `params.referenceId` passthrough.
 */
export function referenceIdOf(job: { type: string; params: Record<string, unknown> }): string | undefined {
  if (job.type === 'generation') {
    const context = job.params.context as { focus?: { kind?: unknown; annotation?: { id?: unknown } } } | undefined;
    const focus = context?.focus;
    if (focus?.kind === 'annotation' && typeof focus.annotation?.id === 'string') {
      return focus.annotation.id;
    }
    return undefined;
  }
  const ref = job.params.referenceId;
  return typeof ref === 'string' ? ref : undefined;
}

type Agent = components['schemas']['Agent'];
/** Derived from the spec; the wire owns this vocabulary. */
type DurabilityEvidence = components['schemas']['DurabilityEvidence'];

/**
 * What the user is told when a resource cannot be read. Keyed by the
 * extraction vocabulary, minus `no-extractor` — that one is a user error
 * (detection asked of a media type that can never yield text) and throws.
 */
export interface WorkerProcessConfig {
  /**
   * The session authenticated as this worker's software-agent identity.
   * Bus emits through this session attribute to that agent.
   */
  session: SemiontSession;
  /**
   * The job types this agent serves. Today every job type a worker
   * subscribes to runs through the same inference engine — different
   * inference engines mean different agents and therefore different
   * worker processes.
   */
  jobTypes: string[];
  inferenceClient: InferenceClient;
  /**
   * The agent (Software) record stamped onto annotations as `generator`
   * and onto resources as `wasAttributedTo`. Same identity that the
   * session is authenticated as.
   */
  generator: Agent;
  /**
   * The resource's bytes, for the detection extraction seam. Dials the
   * Archivist rather than the gateway (SINGLE-KB-MOUNT P4) — which is why it
   * rides the config instead of coming off the session: the session's
   * transport is pointed at the gateway, and this read should not be.
   */
  contentReads: ContentReads;
  logger: Logger;
}

/**
 * Route `transport.emit` calls — choosing resource-scoped vs global based
 * on whether the event is a cross-subscriber broadcast.
 */
/**
 * Census declarations (`WORKER_AWAITED_OPERATIONS`, worker-runtime.ts) for the
 * three operations THIS module awaits. `MarkCommitAwaits` is tied to its call by
 * a `satisfies`; the other two have no operation literal to tie to — they
 * await through the SDK (`session.client.browse.*(...).fresh()`), so
 * their declarations are by convention until SDK bus-backed methods carry their
 * operation in their own type (the census's recorded endgame).
 */
export type MarkCommitAwaits = 'mark:commit';
export type DescriptorReadAwaits = 'browse:resource-requested';
/**
 * The durability probe (COMMIT-ACK-FALSE-FAILURE F1).
 *
 * Deliberately the SINGULAR read, not `browse:annotations-requested`. Reply
 * channels are global fan-out, and the annotation LIST channel is the one
 * measured at ~85 multi-MB frames/min during the 2026-09-03 worker OOM — the
 * reason `WORKER_CHANNELS` was narrowed in the first place. Re-subscribing it
 * to serve a rare error path would undo that fix; one annotation's frame is
 * small.
 */
export type DurabilityProbeAwaits = 'browse:annotation-requested';

/**
 * How long a unit's commit may take before the worker treats the sink as down.
 *
 * Generous relative to an append — the batch is one unit's annotations and the
 * Archivist may be catching up — but FINITE, which is the whole point: the
 * 2026-09-03 hang was an unbounded wait on a confirmation that never came.
 */
const MARK_COMMIT_TIMEOUT_MS = 60_000;

/**
 * Persist a batch of annotations and WAIT for the event log to confirm it
 * (JOB-RESTART-SAFETY P6).
 *
 * Every worker path that mints annotations goes through here. `mark:create` is
 * fire-and-forget: its emit resolves when the gateway accepts the frame, which
 * says nothing about the Stower having appended anything — so a down Archivist
 * discarded a job's whole output while the job reported success. P7's
 * `EMIT_TIMEOUT_MS` stopped those paths HANGING; only the acknowledgement stops
 * them LOSING.
 *
 * Empty is a no-op, not a round trip: a job that found nothing has nothing to
 * make durable, and the caller still proceeds.
 */
async function commitAnnotations(
  session: SemiontSession,
  resourceId: string,
  annotations: readonly { readonly id: string }[],
): Promise<DurabilityEvidence | undefined> {
  if (annotations.length === 0) return undefined;
  try {
    await busRequest(
      workerBusAsPrimitive((session.client.transport as HttpTransport).actor),
      'mark:commit' satisfies MarkCommitAwaits,
      { resourceId, annotations },
      MARK_COMMIT_TIMEOUT_MS,
    );
    return 'acknowledged';
  } catch (error) {
    if (!(error instanceof BusRequestError) || error.code !== 'bus.timeout') throw error;
    const evidence = await probeDurability(session, resourceId, annotations);
    // The batch is in the log; only the acknowledgement was lost. Returning
    // here IS the fix — see `probeDurability`.
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
 * retryable — exactly as before. The message is the original's, so the
 * persisted `error` string is unchanged; this adds evidence beside it rather
 * than replacing it.
 */
export class CommitDurabilityError extends Error {
  override readonly name = 'CommitDurabilityError';
  constructor(message: string, readonly durability: DurabilityEvidence, cause: unknown) {
    super(message, { cause });
  }
}

/**
 * Did the batch land? (COMMIT-ACK-FALSE-FAILURE F1.)
 *
 * A lost `mark:commit-ok` says nothing about the event log. Measured
 * 2026-09-08: a 51-minute Person detection appended all 1,673 of its
 * annotations, the gateway then went down, the ack could not route, and the
 * job reported FAILED over durable data — indistinguishable, to a user, from
 * having produced nothing. The outcome must follow the durable fact, not the
 * arrival of a message.
 *
 * Only the LAST annotation is probed, and that is sufficient rather than
 * approximate: `handleMarkCommit` appends a batch strictly in order and stops
 * at the first failure (`stower.ts`, pinned by
 * `stower-commit-idempotence.test.ts`), so the last id being present means every
 * earlier one is too. Probing all of them would be 1,673 round trips; probing
 * the list channel would re-subscribe the frames that OOM'd the worker (see
 * `DurabilityProbeAwaits`).
 *
 * Every non-answer resolves to `false` — retry — and that asymmetry is
 * deliberate. Since F3 the log refuses a duplicate, so a needless retry costs
 * one re-run of the unit; a wrong `true` loses the whole unit silently, which
 * is the false-success the acknowledgement was introduced to kill. When the
 * probe is unreachable the truthful answer is neither, and forcing it into
 * failure here is the INDETERMINATE state this plan's F2 exists to name.
 */
async function probeDurability(
  session: SemiontSession,
  resourceId: string,
  annotations: readonly { readonly id: string }[],
): Promise<Exclude<DurabilityEvidence, 'acknowledged'>> {
  const last = annotations[annotations.length - 1];
  if (!last) return 'probe-unreachable';
  try {
    await session.client.browse
      .annotation(makeResourceId(resourceId), makeAnnotationId(String(last.id)))
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
    // exists to make. (Observed exactly that under vi.resetModules.)
    const code = isObject(error) && isString(error.code) ? error.code : undefined;
    return code === 'bus.rejected' ? 'probe-refused' : 'probe-unreachable';
  }
}

async function emitEvent<K extends keyof EventMap>(
  session: SemiontSession,
  channel: K,
  payload: EventMap[K],
): Promise<void> {
  // All worker-emitted bus events are global. `job:complete` / `job:fail`
  // are global, `jobId`-keyed correlation signals (#847): the dispatching
  // caller filters by `jobId`, and resource viewers filter the same global
  // stream by `resourceId`. No resource-scoped copy (see RESOURCE_BROADCAST_TYPES).
  await session.client.transport.emit(channel, payload as EventMap[K]);
}

export function startWorkerProcess(config: WorkerProcessConfig): JobClaimAdapter {
  const { session, logger } = config;
  // Workers are HTTP-bound today; the actor is needed for the job-claim
  // protocol (SSE subscribe + ad-hoc channel adds). Cast to HttpTransport
  // is intentional: `LocalTransport` workers don't exist. The adapter
  // itself is transport-neutral — see `WorkerBus` in
  // packages/sdk/src/state/lib/worker-bus.ts.
  const httpTransport = session.client.transport as HttpTransport;
  const adapter = createJobClaimAdapter({
    bus: httpTransport.actor,
    jobTypes: config.jobTypes,
  });

  // Checkpointed resume (ABANDONED-INFERENCE P2): units a reference run
  // completes are accumulated here so the failure path can carry them on
  // job:fail — the queue records them and a retry skips them. Shared
  // between handleJob (which fills it) and the catch below (which reads
  // it); cleared on every terminal outcome.
  const completedUnitsByJob = new Map<string, string[]>();

  // The mid-unit half of the same checkpoint (CHUNK-GRAIN-RESUME P2). Kept
  // beside `completedUnitsByJob` and for the same reason: `job:fail` is the
  // clean-failure path, and without this a job that dies partway through its
  // only unit reports a checkpoint that says nothing happened.
  const unitCursorsByJob = new Map<string, Record<string, UnitCursor>>();

  // Cooperative cancellation (JOB-RESTART-SAFETY P4): a job:cancel-requested
  // targeting the ACTIVE job aborts its signal; the reference loop stops at
  // its next unit boundary and the job moves to cancelled/ carrying its
  // checkpoint — no worker kill. The worker processes one job at a time (the
  // adapter's isProcessing gate), so a single controller keyed by jobId is
  // enough. A pending job's cancel is handled gateway-side; a running
  // job's must be cooperative, or it would be yanked out from under a live
  // worker (the roach-motel race).
  let activeCancel: { jobId: string; controller: AbortController } | null = null;
  httpTransport.actor.addChannels?.(['job:cancel-requested']);
  httpTransport.on('job:cancel-requested', (event) => {
    const targetId = (event as { jobId?: string }).jobId;
    if (targetId && activeCancel?.jobId === targetId) {
      logger.info('Cancel requested for active job — stopping at next unit boundary', { jobId: targetId });
      activeCancel.controller.abort();
    }
  });

  adapter.activeJob$.subscribe((job) => {
    if (!job) return;
    logger.info('Processing job', { jobId: job.jobId, type: job.type, resourceId: job.resourceId });
    const controller = new AbortController();
    activeCancel = { jobId: job.jobId, controller };
    handleJob(adapter, config, job, completedUnitsByJob, controller.signal, unitCursorsByJob)
      .then(() => {
        completedUnitsByJob.delete(job.jobId);
        unitCursorsByJob.delete(job.jobId);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        // Classify HERE, while the error is still typed — on the wire it is
        // only a string (ABANDONED-INFERENCE P3; taxonomy in failure-class.ts).
        const failureClass = classifyFailure(error);
        logger.error('Job failed', { jobId: job.jobId, error: message, failureClass, stack: error instanceof Error ? error.stack : undefined });
        const completedUnits = completedUnitsByJob.get(job.jobId);
        const unitCursors = unitCursorsByJob.get(job.jobId);
        completedUnitsByJob.delete(job.jobId);
        unitCursorsByJob.delete(job.jobId);
        const failAnnotationId = referenceIdOf(job);
        if (isJobType(job.type)) {
          emitEvent(session, 'job:fail', {
            resourceId: job.resourceId,
            jobId: job.jobId,
            jobType: job.type,
            ...(failAnnotationId ? { annotationId: failAnnotationId } : {}),
            error: message,
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
            // Whether this failure is the END, answered by the same predicate
            // the queue applies at failJob (JOB-RESTART-SAFETY P5). Without
            // it a client cannot tell a recovering run from a dead one: it
            // sees job:fail either way and would end its stream on a job the
            // queue is about to re-run.
            willRetry: willRetryAfter(job, failureClass),
          }).catch(() => {});
        }
        adapter.failJob(job.jobId, message);
      })
      .finally(() => {
        if (activeCancel?.jobId === job.jobId) activeCancel = null;
      });
  });

  adapter.start();
  return adapter;
}

// Exported for unit testing — the orchestration (claim→fetch→process→emit→complete)
// is the only thing not otherwise exercised by processors.test.ts.
// Do not call from outside the worker process.
export async function handleJob(
  adapter: JobClaimAdapter,
  config: WorkerProcessConfig,
  job: ActiveJob,
  // The subscription in startWorkerProcess passes its shared accumulator so
  // the failure path can read what the reference branch committed
  // (checkpointed resume); standalone callers may omit it — a fresh map
  // changes no behavior, only discards the checkpoint on return.
  completedUnitsByJob: Map<string, string[]> = new Map(),
  // Cancellation signal (JOB-RESTART-SAFETY P4): aborted when a
  // job:cancel-requested targets this job; the reference loop stops at its
  // next unit boundary and the job moves to cancelled/. Standalone callers
  // omit it — an undefined signal never aborts.
  signal?: AbortSignal,
  // The mid-unit half of the checkpoint, same sharing rule as
  // `completedUnitsByJob`: filled here, read by the failure path.
  unitCursorsByJob: Map<string, Record<string, UnitCursor>> = new Map(),
): Promise<void> {
  const start = performance.now();
  let outcome: 'completed' | 'failed' = 'completed';
  try {
    return await withSpan(
      `job:${job.type}`,
      () => handleJobInner(adapter, config, job, completedUnitsByJob, signal, unitCursorsByJob),
      {
        kind: SpanKind.CONSUMER,
        attrs: {
          'job.type': job.type,
          'job.id': job.jobId,
          'resource.id': job.resourceId,
        },
      },
    );
  } catch (err) {
    outcome = 'failed';
    throw err;
  } finally {
    recordJobOutcome(job.type, outcome, performance.now() - start);
  }
}

async function handleJobInner(
  adapter: JobClaimAdapter,
  config: WorkerProcessConfig,
  job: ActiveJob,
  completedUnitsByJob: Map<string, string[]>,
  signal?: AbortSignal,
  unitCursorsByJob: Map<string, Record<string, UnitCursor>> = new Map(),
): Promise<void> {
  const { session, inferenceClient, generator } = config;
  const { userId, jobId } = job;
  // `jobType` is a required, enumerated field on every lifecycle command, but
  // arrives off the bus as a plain string. Narrow once here so the emits below
  // are checked against the wire contract instead of asserted past it.
  if (!isJobType(job.type)) {
    adapter.failJob(jobId, `Unrecognized job type: ${job.type}`);
    return;
  }
  const jobType: JobType = job.type;
  // The job arrives off the bus with a plain-string id — this is the entry
  // boundary, so brand once here rather than casting at every call that wants
  // a `ResourceId` (BRAND-UPSTREAM).
  const resourceId = makeResourceId(job.resourceId);

  // Annotation-scoped jobs (today: generation, triggered from a
  // reference) carry the source annotation through every lifecycle
  // payload so the UI can attach visual feedback to that annotation.
  // Resource-scoped jobs (bulk reference/tag/highlight/comment/
  // assessment detection scanning a whole resource) leave it unset.
  const annotationId = referenceIdOf(job);
  // No `userId`: the job lifecycle commands declare only `_userId`, injected by
  // the gateway from the authenticated session. Spreading an extra field would
  // put out-of-contract data on a global channel — and would not be caught by
  // `emitEvent`'s typing, because TypeScript suppresses excess-property checks
  // for spreads and for variables passed by reference.
  // 1-based, and on EVERY lifecycle event including progress: the queue re-runs
  // a failed job silently, so without this an operator cannot tell a re-run from
  // a first run, and the provider spend already counted in Prometheus cannot be
  // attributed to a repeated document. Always stated, never left to absence —
  // `attempt: 1` is a fact the emitter always knows.
  const attempt = job.retryCount + 1;
  const lifecycleBase = {
    resourceId, jobId, jobType, attempt,
    ...(annotationId ? { annotationId } : {}),
  };

  // ── Job lifecycle signaling ───────────────────────────────────────────
  // `job:start` / `job:report-progress` / `job:complete` / `job:fail`
  // are the ONE unified lifecycle family. Start/complete/fail are
  // persisted by Stower; progress is ephemeral UI feedback and Stower
  // ignores it. UI consumers filter by `jobType` and/or `annotationId`
  // in the payload.

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
  /** Every TERMINAL payload; `job:start` deliberately uses the bare base. */
  const terminalBase = () => ({ ...lifecycleBase, ...(durability ? { durability } : {}) });

  await emitEvent(session, 'job:start', lifecycleBase);

  if (!config.jobTypes.includes(jobType)) {
    adapter.failJob(jobId, `Worker not configured for job type: ${jobType}`);
    return;
  }

  // Detection needs the resource's text plus a media-appropriate way to anchor a
  // detected span. Both come from `prepareDetection`, which reads through the
  // same extractor registry the Smelter embeds from — so a resource that can be
  // embedded can be detected over, scanned PDFs included.
  //
  // Two failures, deliberately distinguished. A media type with no extractor at
  // all ('none' — a zip, an image) can never yield text, so asking to detect
  // over it is a user error and throws (surfaces as job:fail). A resource whose
  // extraction *failed* — encrypted, corrupt, a scan OCR could not read —
  // declines cleanly and completes the job saying which. Generation reads the
  // annotation in its params, not the source bytes, so it is not prepared here.
  let ready: { text: string; buildAnnotation: BuildAnnotation } | null = null;
  if (jobType !== 'generation') {
    const descriptor = await session.client.browse.resource(resourceId).fresh();
    const mediaType = getPrimaryMediaType(descriptor);
    // Its own span: extraction (fetch + decode, or a multi-second OCR pass on
    // a scanned PDF) is otherwise indistinguishable from inference in a
    // trace, which is exactly what made a 411 s opaque job hard to diagnose.
    const source = await withSpan(
      'detection:prepare',
      () => prepareDetection(mediaType ?? '', config.contentReads, resourceId, userId, generator, (rid) => session.client.browse.resourceAnchoredText(rid)),
      { attrs: { 'resource.id': resourceId as unknown as string, 'media.type': mediaType ?? 'unknown' } },
    );

    if ('declined' in source) {
      if (source.declined === 'not-yet') {
        // The Smelter has not finished deriving this resource's anchored text
        // (SMELTER-OWNS-OCR D3). Not an error — the work is not ready. Throw a
        // TRANSIENT failure (classifyFailure leaves it unrecognized → transient)
        // so the job retries and the retry finds the store warm. NEVER OCR here:
        // the Smelter is the sole producer.
        throw new Error(`Anchored text not yet derived for resource ${resourceId} — Smelter has not settled; retrying`);
      }
      if (source.declined === 'no-extractor') {
        // A media type with nothing to extract is a user error, not weather —
        // retrying cannot change it (ABANDONED-INFERENCE P3, A4).
        throw new DeterministicJobError(`Cannot run ${jobType} on resource ${resourceId}: media type '${mediaType ?? 'unknown'}' has no extractable text to analyze`);
      }
      if (source.declined === 'no-map' || source.declined === 'unknown') {
        // Terminal, and loud: no-map is drift between `yieldsGeometryOf` and the
        // Smelter's skip decision (a geometry type it declined to map); unknown
        // is a resource with no content identity. Neither is retryable, and
        // both mean something upstream is wrong — surface it, do not complete
        // as if the resource simply had nothing to detect.
        throw new DeterministicJobError(`Cannot run ${jobType} on resource ${resourceId}: anchored-text consult returned '${source.declined}'`);
      }
      // A genuine content decline (encrypted, corrupt, scanned-without-OCR,
      // empty) — the resource legitimately has nothing to detect over. A clean
      // completion carrying the reason, not a failure.
      await emitEvent(session, 'job:complete', {
        ...terminalBase(),
        result: {
          kind: 'declined',
          declined: true,
          reason: source.declined,
        },
      });
      adapter.completeJob();
      return;
    }
    ready = source;
  }

  const onProgress: OnProgress = (percentage, message, extra) => {
    // Progress doubles as the worker's liveness heartbeat: it feeds the
    // stall watchdog here and refreshes the gateway janitor's mtime
    // heartbeat via the job:report-progress mirror.
    //
    // `message` is a code plus typed params, forwarded verbatim — the
    // producer says WHAT happened and every client renders it in its own
    // language (ASSIST-PROGRESS-CONSOLIDATION A6). No sentence is composed
    // anywhere on this path. (P1 dropped the prose arg here as an interim;
    // P2 gave the processors codes worth forwarding.)
    adapter.touchActivity();
    emitEvent(session, 'job:report-progress', {
      ...terminalBase(),
      percentage,
      progress: {
        percentage, message,
        ...(annotationId ? { annotationId } : {}),
        ...(extra ?? {}),
      },
    }).catch(() => {});
  };

  /**
   * Per-unit resume positions for THIS attempt (CHUNK-GRAIN-RESUME P2),
   * reported on every checkpoint and carried onto a terminal failure.
   * In-memory only: the durable copy is the queue's, merged monotonically,
   * because two checkpoints can be in flight and the older can land last.
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
    record(await commitAnnotations(session, String(resourceId), annotations));
    unitCursors.set(checkpoint.unit, checkpoint.cursor);
    // Published to the caller's accumulator as it moves: the failure path runs
    // OUTSIDE this function, so a cursor only this scope knows about would be
    // lost on exactly the failures it exists to survive.
    unitCursorsByJob.set(job.jobId, Object.fromEntries(unitCursors));
    await emitEvent(session, 'job:checkpoint', {
      jobId: job.jobId,
      completedUnits: [...(completedUnitsByJob.get(job.jobId) ?? [])],
      unitCursors: Object.fromEntries(unitCursors),
    });
  };

  if (jobType === 'highlight-annotation') {
    const { result } = await processHighlightJob(
      ready!.text, inferenceClient, asJobParams<HighlightDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit
      // (CHUNK-GRAIN-RESUME P3). Empty on a first attempt.
      job.unitCursors,
    );
    await emitEvent(session, 'job:complete', {
      ...terminalBase(),
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'comment-annotation') {
    const { result } = await processCommentJob(
      ready!.text, inferenceClient, asJobParams<CommentDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit
      // (CHUNK-GRAIN-RESUME P3). Empty on a first attempt.
      job.unitCursors,
    );
    await emitEvent(session, 'job:complete', {
      ...terminalBase(),
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'assessment-annotation') {
    const { result } = await processAssessmentJob(
      ready!.text, inferenceClient, asJobParams<AssessmentDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit
      // (CHUNK-GRAIN-RESUME P3). Empty on a first attempt.
      job.unitCursors,
    );
    await emitEvent(session, 'job:complete', {
      ...terminalBase(),
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'reference-annotation') {
    // Checkpointed resume (ABANDONED-INFERENCE P2). A retried claim skips
    // the units earlier attempts completed; every remaining unit commits
    // through the callback the moment it finishes — the awaited emissions
    // ARE the acceptance that lets the unit count as complete, and the
    // accumulator feeds the job:fail payload if a later unit dies. The
    // post-run batch this replaces was N2's discard-everything mechanism.
    const params = asJobParams<DetectionParams>(job.params);
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
        await emitEvent(session, 'job:checkpoint', {
          jobId: job.jobId,
          completedUnits: [...committed],
          ...(unitCursors.size > 0 ? { unitCursors: Object.fromEntries(unitCursors) } : {}),
        });
      },
      signal,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit
      // (CHUNK-GRAIN-RESUME P3). Empty on a first attempt.
      job.unitCursors,
    );
    // Cooperative cancellation (JOB-RESTART-SAFETY P4): the loop stopped
    // because a cancel was requested for this job. Announce it so the queue
    // moves the (still-running) job to cancelled/ — never yanked out from
    // under this worker — carrying the units it did finish (already
    // checkpointed above). completeJob releases the claim; a cancel is a
    // clean terminal, not a failure.
    if (signal?.aborted) {
      await emitEvent(session, 'job:cancel', {
        ...terminalBase(),
        ...(committed.length > 0 ? { completedUnits: [...committed] } : {}),
      });
      adapter.completeJob();
      return;
    }
    await emitEvent(session, 'job:complete', {
      ...terminalBase(),
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'tag-annotation') {
    const { result } = await processTagJob(
      ready!.text, inferenceClient, asJobParams<TagDetectionParams>(job.params), ready!.buildAnnotation, onProgress,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit
      // (CHUNK-GRAIN-RESUME P3). Empty on a first attempt.
      job.unitCursors,
    );
    await emitEvent(session, 'job:complete', {
      ...terminalBase(),
      result,
    });
    adapter.completeJob();

  } else if (jobType === 'generation') {
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
    // The gateway writes content to disk and emits `yield:create`
    // internally; we only learn the new resourceId from the response.
    const genParams = job.params as {
      prompt?: string;
      language?: string;
      entityTypes?: string[];
    };
    // Annotation-focus generation auto-binds to the triggering reference; the
    // id is derived from the context's focus (the wire no longer carries it).
    const genReferenceId = referenceIdOf(job);

    // The Save location the user typed is AUTHORITATIVE and there is no
    // fallback (GENERATION-OUTPUT-FORMAT D6/D9). Deriving unconditionally
    // meant the artifact landed at file://<title-slug><ext> and renaming the
    // title MOVED THE FILE; a `||` fallback would now only hide a caller that
    // forgot. The guard above rejects an absent OR empty uri, so by here it
    // is a real location.
    const storageUri = job.params.storageUri;

    // Faithful and incurious (D7): the worker writes the requested bytes to
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

    const { resourceId: newResourceId } = await session.client.yield.resource({
      name: genResult.title,
      file: Buffer.from(genResult.content),
      format: genResult.format,
      storageUri,
      sourceResourceId: resourceId as unknown as string,
      ...(genReferenceId ? { sourceAnnotationId: genReferenceId } : {}),
      ...(genParams.prompt ? { generationPrompt: genParams.prompt } : {}),
      ...(genParams.language ? { language: genParams.language } : {}),
      ...(genParams.entityTypes && genParams.entityTypes.length > 0 ? { entityTypes: genParams.entityTypes } : {}),
      generator,
    });

    // Resource-focus generation has no triggering reference — mint a navigable
    // source→derived reference annotation (YIELD-FROM-RESOURCE Fork 2b) so the
    // derivation is a first-class edge, targeting the whole source resource
    // (resource-level, no selector). Annotation-focus generation instead auto-binds
    // the triggering reference via `sourceAnnotationId` on the upload above.
    if (!genReferenceId) {
      const { annotation: provenanceRef } = assembleAnnotation(
        {
          motivation: 'linking',
          target: { source: String(resourceId) },
          body: { type: 'SpecificResource', source: String(newResourceId), purpose: 'linking' },
        },
        generator,
      );
      record(await commitAnnotations(session, String(resourceId), [provenanceRef]));
    }

    // Inline citations: mint each as a linking annotation ON THE DERIVED
    // resource — the target anchors the claim, the body points at the cited
    // source — so citations are first-class references like any other.
    //
    // Anchoring branches on the artifact's anchoring model. Text formats
    // anchor by character offset into the DECODED text — consumers apply
    // selectors to the decoded string, not raw bytes (INLINE-CITATIONS P1).
    // A PDF anchors by PAGE GEOMETRY (PDF-GENERATION P4): the citation's
    // offsets index the Typst SOURCE and would render nothing, so each claim
    // is re-found in the artifact's own text layer (two-stage search — strict,
    // then break-aware for hyphenation) and located to rects. A claim the
    // search cannot find is dropped LOUDLY, never minted wrong.
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
            makeResourceId(String(newResourceId)),
            userId,
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
              source: String(newResourceId),
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

    record(await commitAnnotations(session, String(newResourceId), citationRefs));

    await emitEvent(session, 'job:complete', {
      ...terminalBase(),
      result: { kind: 'generation', resourceId: newResourceId, resourceName: genResult.title, truncated: genResult.result.truncated },
    });
    adapter.completeJob();

  } else {
    adapter.failJob(jobId, `Unknown job type: ${jobType}`);
  }
}
