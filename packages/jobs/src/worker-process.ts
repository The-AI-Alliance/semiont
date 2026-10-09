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
 * claiming, and held jobs that say their own lifecycle, commit their own
 * annotations and settle once (docs/protocol/WORKER-CONTRACT.md). This file
 * is the work: it runs each job the claims hand out through its processor,
 * and says how it went.
 */

import { isHeldMark, type MarkMotivation } from './types';
import type { ClaimsObservable, HeldJob, SemiontClient } from '@semiont/sdk';
import { isGenerationJobParams, getPrimaryMediaType, assembleAnnotation, findClaimSpan, textOffsets, capabilitiesOf, jobMatchesFilter, MARK_MOTIVATIONS, GENERATED_TEXT_ASKS_COUNT, type JobFilter, type ResourceId } from '@semiont/core';

import type { InferenceClient } from '@semiont/inference';
import type { Logger, components, AssembledAnnotation, Annotation, AnchoredText, JobDetectionResult, TextOffsets, UnitCursor } from '@semiont/core';
import { annotationIdFor } from '@semiont/event-sourcing';
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
  spanAnchor,
  type OnProgress,
  type BuildAnnotation,
  type ProcessorResult,
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
  logger: Logger;
}

/**
 * Census declarations (`WORKER_AWAITED_OPERATIONS`, worker-runtime.ts) for the
 * operations THIS module awaits. What the SDK awaits is the SDK's to name: a
 * claim (`JOB_CLAIM_CHANNELS`), and a held job's commit
 * (`JOB_COMMIT_CHANNELS`). Neither declaration has an operation literal to
 * tie to: both await through the SDK (`client.browse.*`), whose bus-backed
 * methods do not carry their operation in their own type, so the
 * declarations are by convention.
 */
export type DescriptorReadAwaits = 'browse:resource-requested';
/**
 * The read of a PDF this job has just yielded (`generatedPdfText`): the
 * operation detection's consult awaits, awaited here for the new resource.
 */
export type GeneratedTextAwaits = 'browse:anchored-text-requested';

/**
 * The text of a PDF this job has just yielded, with where each word is on its
 * pages — or why it is not to be had.
 *
 * It is the Smelter's text, asked for as detection asks for a PDF's, so a
 * PDF's text has one producer: the citations are anchored in the text the
 * viewer shows and every later detection reads. This worker extracts none.
 *
 * The text is not there the moment the resource is. An ask is answered at
 * once when the text is stored; otherwise the Archivist holds it while it
 * waits for the Smelter to say it has settled the content (`smelt:settled`),
 * and then answers `not-yet`. So `not-yet` is asked again, as many times as
 * the timing table states, and `waiting` is called before each further ask:
 * whoever follows the job reads a long silence as a stall.
 *
 * An absence is returned and never thrown. The resource exists by now, and a
 * failed job is retried, which would make it a second time. `unknown` should
 * not be seen at all for a resource the Archivist has just answered for: its
 * append writes the view before it answers.
 */
async function generatedPdfText(
  client: SemiontClient,
  resourceId: ResourceId,
  waiting: () => void,
): Promise<AnchoredText | { absent: string }> {
  for (let ask = 1; ask <= GENERATED_TEXT_ASKS_COUNT; ask++) {
    if (ask > 1) waiting();
    const answer = await client.browse.resourceAnchoredText(resourceId);
    switch (answer.kind) {
      case 'extracted': return { text: answer.text, items: answer.items ?? [] };
      case 'not-yet': continue;
      case 'declined': return { absent: answer.declined };
      case 'no-map':
      case 'unknown': return { absent: answer.kind };
      default: {
        // Narrows to `never` while every member of `AnchoredTextAnswer` is
        // handled above, so a member added to the wire stops this compiling.
        // At runtime a newer Smelter can still send one this build was not
        // compiled with, and that is an absence like the others.
        const unhandled: never = answer;
        return { absent: `an answer this worker does not know: ${JSON.stringify(unhandled)}` };
      }
    }
  }
  return { absent: 'not-yet' };
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
      // aborts its signal; the job stops at its next stopping place (a
      // detection after the chunk it is on, a generation before it uploads)
      // and moves to cancelled/ — no worker kill. A pending job's cancel is
      // handled by the dispatcher; a running job's must be cooperative, or it
      // would be yanked out from under a live worker (the roach-motel race).
      job.cancelled.addEventListener('abort', () => {
        logger.info('Cancel requested for active job — stopping at its next stopping place', { jobId: job.jobId });
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
          // follower cannot tell a recovering run from a dead one. It also
          // states what a commit that was not established observed, when the
          // job made one: that is the held job's own to say.
          await job.fail(message, {
            ...(completedUnits && completedUnits.length > 0 ? { completedUnits } : {}),
            // Where each unfinished unit got to. Absent rather than `{}` when
            // nothing was reached: an empty object would claim units were
            // tracked and none progressed.
            ...(unitCursors && Object.keys(unitCursors).length > 0 ? { unitCursors } : {}),
            ...(failureClass !== undefined ? { failureClass } : {}),
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
  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
  try {
    outcome = await withSpan(
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
  } finally {
    recordJobOutcome({ jobType: job.jobType, ...(motivation ? { motivation } : {}) }, outcome, performance.now() - start);
  }
}

async function handleJobInner(
  config: WorkerProcessConfig,
  job: HeldJob,
  completedUnitsByJob: Map<string, string[]>,
  unitCursorsByJob: Map<string, Record<string, UnitCursor>> = new Map(),
): Promise<'completed' | 'cancelled'> {
  const { client, inferenceClient, generator } = config;
  // Who asked for the job is not among what the worker holds: it cites the
  // job, and the Stower derives the requester from the dispatcher's record of
  // it — provenance is derived, never asserted.
  const { jobId, jobType, resourceId, params } = job;
  // What this job is, as a claim or a config section names it, for a message.
  const what = jobType === 'mark' ? `mark (${motivationOf(job) ?? 'no motivation'})` : jobType;
  // Aborted when a cancellation names this job; the job stops at its next
  // stopping place and moves to cancelled/.
  const signal = job.cancelled;

  // ── Job lifecycle signaling ───────────────────────────────────────────
  // The held job says its own lifecycle (`job.start`, `job.progress`,
  // `job.checkpoint`, and one of `job.complete`, `job.fail`, `job.cancel`),
  // each globally, with the job's identity, its attempt, and the annotation a
  // generation job is anchored to. Start, complete and fail are recorded by
  // the Stower; progress is passed on and not recorded.
  //
  // The held job commits for itself too (`job.commit`). Every path here that
  // makes annotations commits them through it, a batch at a time, and waits
  // for the record to have the batch: an emit alone resolves when the gateway
  // takes the frame, and says nothing of the record.
  // A reference job commits per chunk, and a generation on two resources. The
  // job states how its commits were established when it settles.

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
  let ready: { text: string; offsets: TextOffsets; buildAnnotation: BuildAnnotation } | null = null;
  if (job.jobType === 'mark') {
    const descriptor = await client.browse.resource(resourceId).fresh();
    const mediaType = getPrimaryMediaType(descriptor);
    // Its own span: extraction (fetch + decode, or a multi-second OCR pass on
    // a scanned PDF) is otherwise indistinguishable from inference in a
    // trace.
    const source = await withSpan(
      'detection:prepare',
      () => prepareDetection(
        mediaType ?? '',
        (rid) => client.browse.resourceRepresentation(rid),
        resourceId,
        generator,
        (rid) => client.browse.resourceAnchoredText(rid),
      ),
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
      await job.complete({ declined: true, reason: source.declined });
      return 'completed';
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
    await job.commit(resourceId, annotations);
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

  /**
   * Settle a detection as it ended. One that a cancellation stopped is
   * announced as cancelled, so the queue moves the (still-running) job to
   * cancelled/ — never yanked out from under this worker — naming the units
   * it did finish. A cancel is a clean terminal, not a failure.
   */
  const settle = async (held: Extract<HeldJob, { jobType: 'mark' }>, ended: ProcessorResult<JobDetectionResult>): Promise<'completed' | 'cancelled'> => {
    if ('cancelled' in ended) {
      const { completedUnits } = ended.cancelled;
      await held.cancel(completedUnits.length > 0 ? { completedUnits } : {});
      return 'cancelled';
    }
    await held.complete(ended.result);
    return 'completed';
  };

  if (job.jobType === 'mark' && isHeldMark(params, 'highlighting')) {
    return settle(job, await processHighlightJob(
      ready!.text, ready!.offsets, inferenceClient, params, ready!.buildAnnotation, onProgress, config.logger, signal,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit, so
      // a partway unit resumes at its offset instead of the top. Empty on a
      // first attempt.
      job.unitCursors,
    ));

  } else if (job.jobType === 'mark' && isHeldMark(params, 'commenting')) {
    return settle(job, await processCommentJob(
      ready!.text, ready!.offsets, inferenceClient, params, ready!.buildAnnotation, onProgress, config.logger, signal,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    ));

  } else if (job.jobType === 'mark' && isHeldMark(params, 'assessing')) {
    return settle(job, await processAssessmentJob(
      ready!.text, ready!.offsets, inferenceClient, params, ready!.buildAnnotation, onProgress, config.logger, signal,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    ));

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

    return settle(job, await processReferenceJob(
      ready!.text, ready!.offsets, inferenceClient, remaining, ready!.buildAnnotation, onProgress, config.logger, signal,
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
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    ));

  } else if (job.jobType === 'mark' && isHeldMark(params, 'tagging')) {
    return settle(job, await processTagJob(
      ready!.text, ready!.offsets, inferenceClient, params, ready!.buildAnnotation, onProgress, config.logger, signal,
      // The durability write, per chunk, awaited; folds into the terminal
      // durability evidence like every commit, and carries the unit's cursor.
      commitChunk,
      // …and the other direction: where an earlier attempt left each unit.
      // Empty on a first attempt.
      job.unitCursors,
    ));

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
      inferenceClient, job.params, onProgress, config.logger, signal,
    );
    // Cancelled by the time its model had answered: nothing is uploaded,
    // nothing is committed. Past this point the job runs to its end.
    if ('cancelled' in genResult) {
      await job.cancel({});
      return 'cancelled';
    }

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
    //
    // Its id is what it is, as every annotation a worker commits has: a
    // retried job that makes the same link commits it under the same id. It
    // is anchored nowhere on the source, so its anchor is the empty string.
    if (!genReferenceId) {
      const body = { type: 'SpecificResource' as const, source: newResourceId, purpose: 'linking' as const };
      const { annotation } = assembleAnnotation({ motivation: 'linking', target: { source: resourceId }, body }, generator);
      const provenanceRef = { ...annotation, id: annotationIdFor({ resourceId, motivation: 'linking', anchor: '', body }) };
      await job.commit(resourceId, [provenanceRef]);
    }

    // Inline citations: mint each as a linking annotation ON THE DERIVED
    // resource — the target anchors the claim, the body points at the cited
    // source — so citations are first-class references like any other.
    //
    // Anchoring branches on the artifact's anchoring model. Text formats
    // anchor by offset into the DECODED text, in code points — consumers apply
    // selectors to the decoded text, not raw bytes. A PDF anchors by PAGE
    // GEOMETRY: the citation's offsets count the Typst SOURCE and would
    // render nothing, so each claim is re-found in the artifact's own text
    // (two-stage search — strict, then break-aware for hyphenation) and
    // located to rects. That text is the Smelter's (`generatedPdfText`). A
    // claim the search cannot find is dropped LOUDLY, never minted wrong,
    // and so is every claim of a PDF whose text is not to be had.
    // Collected, then committed once: the citations all land on the DERIVED
    // resource, so they are one batch keyed by `newResourceId` — a different
    // resource from the provenance edge above, which is why they cannot share
    // a commit.
    const citationRefs: AssembledAnnotation['annotation'][] = [];
    if (genResult.format === 'application/pdf' && genResult.citations.length > 0) {
      const anchored = await generatedPdfText(
        client,
        newResourceId,
        // What the job last said, said again: the wait is not a stage of its own.
        () => onProgress(100, { code: 'complete-generated', truncated: genResult.truncated }),
      );
      if ('absent' in anchored) {
        config.logger.warn('PDF citations dropped — the generated artifact\'s text is not to be had', {
          jobId, resourceId: newResourceId, citations: genResult.citations.length, reason: anchored.absent,
        });
      } else {
        // The text's conversions, made once for every claim looked for in it.
        const offsets = textOffsets(anchored.text);
        for (const citation of genResult.citations) {
          const span = findClaimSpan(anchored, offsets, citation.exact);
          if (!span) {
            config.logger.warn('PDF citation dropped — claim not found in the rendered text', {
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
            anchored,
            offsets,
            newResourceId,
            generator,
            'linking',
            { exact: anchored.text.slice(offsets.indexAt(span.start), offsets.indexAt(span.end)), start: span.start, end: span.end },
            { type: 'SpecificResource', source: citation.resourceId, purpose: 'linking' },
          );
          citationRefs.push(citationRef);
        }
      }
    } else {
      for (const citation of genResult.citations) {
        const body = { type: 'SpecificResource' as const, source: citation.resourceId, purpose: 'linking' as const };
        const { annotation } = assembleAnnotation(
          {
            motivation: 'linking',
            target: {
              source: newResourceId,
              selector: [
                { type: 'TextPositionSelector', start: citation.start, end: citation.end },
                { type: 'TextQuoteSelector', exact: citation.exact },
              ],
            },
            body,
          },
          generator,
        );
        // The id of what it is: the claim's span on the new resource, and the resource it cites.
        citationRefs.push({ ...annotation, id: annotationIdFor({ resourceId: newResourceId, motivation: 'linking', anchor: spanAnchor(citation), body }) });
      }
    }

    await job.commit(newResourceId, citationRefs);

    await job.complete({ resourceId: newResourceId, resourceName: genResult.title, truncated: genResult.truncated });
    return 'completed';

  } else {
    // A job this worker claims and cannot run: a tagging job handed over
    // without the schema the Dispatcher resolves, say. A second attempt
    // would be handed the same job, so it skips the retry budget.
    throw new DeterministicJobError(`No processor for job: ${what}`);
  }
}
