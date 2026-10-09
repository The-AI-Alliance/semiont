/**
 * Job Processors
 *
 * Pure functions that take content + inference client + params,
 * report progress via callback, and return annotations + results.
 *
 * No EventBus, no queue, no side effects except calling inference.
 * Driven by the remote worker process (worker-process.ts), which claims
 * jobs over SSE and dispatches by jobType to these functions.
 */

import { AnnotationDetection } from './workers/annotation-detection';
import { extractEntities } from './workers/detection/entity-extractor';
import { DEFAULT_MAX_TOKENS, generateResourceFromTopic } from './workers/generation/resource-generation';
import { compileTypst, MAX_COMPILE_REPAIRS } from './workers/generation/typst-compiler';
import { withinByteBudget, MAX_PDF_BYTES } from '@semiont/content';
import { resolveCitationTokens, collectCitableIds, type GenerationCitation } from './workers/generation/citation-resolver';
import { GENERATABLE_MEDIA_TYPES, type Annotation, type GenerationJobParams, type Logger, type SupportedMediaType, type components, type JobDetectionResult, type UnitCursor } from '@semiont/core';
import { reconcile, type TextOffsets, type TextSpan } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { HeldMarkParams } from './types';
import { DeterministicJobError } from './failure-class';
import { noteAnchor } from './workers/detection/anchor-audit';
import { runBounded } from './workers/detection/bounded-concurrency';

/**
 * Turn a detected span into a stored annotation: `annotationOfSpan`
 * (`@semiont/core`), with the text or the PDF's anchored text, the resource
 * and the generator closed over by the caller (see `prepareDetection`). The
 * detection processor supplies only the motivation, the span (its offsets
 * into the text the model was asked about, in code points), and any
 * motivation-specific body. This is the single axis that varies by media
 * type, so the detection processors themselves stay media-agnostic.
 */
export type BuildAnnotation = (
  motivation: Motivation,
  span: TextSpan,
  body?: Annotation['body'],
) => Annotation;

/**
 * Progress callback. The two positional args are the required `JobProgress`
 * fields (`percentage`, `message`). The third optional arg carries the
 * job-type-specific fields (`completedEntityTypes`, `requestParams`, etc.)
 * that the progress UI renders.
 *
 * Anything in `extra` describing the RUN rather than the moment must be passed
 * on EVERY call: the client's `progress$` replaces its value per event, so a
 * field sent once disappears on the next tick.
 *
 * `message` is a CODE plus typed params, never a prose sentence. The producer
 * reports what happened; each client renders it in the user's language —
 * react-ui from its 29 locales, the Go launcher from its English map. The
 * vocabulary is frozen by the census of these call sites: adding a shape
 * means adding a variant to `JobProgressMessage.json` and copy in every
 * client, not composing a new sentence here.
 */
export type OnProgress = (
  percentage: number,
  message: JobProgressMessage,
  extra?: Partial<JobProgress>,
) => void;

type JobProgress = components['schemas']['JobProgress'];
/** Derived from the wire, never restated: the per-unit entry's shape is the
 * spec's, so a field added there reaches these accumulators by regeneration
 * rather than by someone remembering two places. */
type CompletedItem = NonNullable<JobProgress['completedItems']>[number];
type JobProgressMessage = components['schemas']['JobProgressMessage'];

/** The five W3C motivations this system mints — a closed vocabulary, so it is
 *  typed as one rather than as `string`. */
export type Motivation = Annotation['motivation'];

/**
 * How a processor ended: it ran to its end and has the job's result, or a
 * cancellation stopped it and it has the units it had finished by then, which
 * is what `job:cancel` names. A unit it was partway through is not among them.
 *
 * Annotations are in neither. They leave through `onChunkComplete`, per chunk —
 * a return that also carried them would be a second path to the same write.
 */
export type ProcessorResult<R> =
  | { result: R }
  | { cancelled: { completedUnits: string[] } };

/**
 * How a job of one unit that a cancellation stopped ended. `next` is where its
 * walk stands: at the end of the text the unit is finished, and is named.
 */
function stoppedAt(unit: string, next: number, offsets: TextOffsets): { cancelled: { completedUnits: string[] } } {
  return { cancelled: { completedUnits: next >= offsets.length ? [unit] : [] } };
}

/**
 * Identity key for a built annotation: motivation + anchored span + body.
 * Two annotations with the same key are the same event written twice.
 */
function annotationDedupeKey(ann: Record<string, unknown>): string {
  const target = ann.target as
    | { selector?: Array<{ type: string; start?: number; end?: number; value?: string; exact?: string; prefix?: string; suffix?: string }> }
    | undefined;
  const selectors = Array.isArray(target?.selector) ? target.selector : [];
  const pos = selectors.find((s) => s.type === 'TextPositionSelector');
  // Anchor identity is media-specific. Text annotations carry a
  // TextPositionSelector (durable offsets). PDF annotations have none —
  // their anchor is the per-line FragmentSelector viewrect geometry plus the
  // TextQuoteSelector text. Keying only on TextPositionSelector would collapse
  // every PDF annotation sharing a motivation+body onto one (its offsets fall
  // back to '?'), so e.g. multiple PDF highlights emit as a single annotation.
  let anchor: string;
  if (pos) {
    anchor = `pos:${pos.start ?? '?'}:${pos.end ?? '?'}`;
  } else {
    const frags = selectors.filter((s) => s.type === 'FragmentSelector').map((s) => s.value ?? '').join(',');
    const quote = selectors.find((s) => s.type === 'TextQuoteSelector');
    anchor = `frag:${frags}|quote:${quote?.exact ?? ''}:${quote?.prefix ?? ''}:${quote?.suffix ?? ''}`;
  }
  return [ann.motivation as string, anchor, JSON.stringify(ann.body ?? null)].join('|');
}

/**
 * THE dedupe decider — one mechanism for all five detection types. It drops
 * annotations identical in the fields that define an annotation's meaning:
 * motivation, anchored span, and body.
 *
 * Two things produce such repeats. Adjacent chunks overlap, so the same span
 * arrives twice. And each LLM-emitted span is reconciled independently (no
 * cross-entry coordination), with `reconcile`'s `first-of-many`
 * fallback anchoring every undisambiguated entry at the *same* first
 * occurrence — so a phrase repeated in non-distinctive context yields several
 * entries on one span.
 *
 * What it does NOT drop: same span, *different* body (e.g. the same text
 * tagged as two entity types, or two distinct comments on one passage).
 * Those are legitimately distinct annotations.
 *
 * Held across a stream of chunk batches, because there is no post-pass to
 * collapse repeats in. Scope it to one emission stream — per unit for
 * reference detection, per job for the four motivations. Never add a batch
 * post-pass beside it (gated).
 */
function makeSpanDeduper(): (annotations: Annotation[]) => Annotation[] {
  const seen = new Set<string>();
  return (annotations) => {
    const out: Annotation[] = [];
    for (const ann of annotations) {
      const key = annotationDedupeKey(ann);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ann);
    }
    return out;
  };
}

/**
 * A `mark` job's counts. `found` is what the model proposed and `persisted`
 * what the log holds; `errors`, how many proposals could not be anchored in the
 * text, is stated only when there were any — absent is the one way to say none.
 */
function detected(found: number, persisted: number, errors: number): JobDetectionResult {
  return { found, persisted, ...(errors > 0 ? { errors } : {}) };
}

/**
 * Where one unit stands once the chunk just handed over is durable: the
 * cursor a retry resumes that unit from, instead of re-running the chunks it
 * already committed.
 *
 * The unit is named HERE rather than in the detection layer, which knows about
 * chunks and nothing about jobs: for a linking job a unit is an entity type,
 * for a tagging job a category — both loop over several — and for the other
 * three the job runs exactly one unit, its own motivation.
 */
export interface UnitCheckpoint {
  unit: string;
  cursor: UnitCursor;
}

export async function processHighlightJob(
  content: string,
  /** The content's own conversions (`textOffsets(content)`), made once where the content is first held. */
  offsets: TextOffsets,
  inferenceClient: InferenceClient,
  params: HeldMarkParams<'highlighting'>,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
  /** The held job's cancellation: the job stops after the chunk it is on, and reports nothing more. */
  signal: AbortSignal,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each unit, keyed the same way the checkpoint
   * is. A unit absent here starts at the top, which is every unit of a first
   * attempt. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobDetectionResult>> {
  // Cancelled before it began: nothing is asked, and nothing is reported.
  if (signal.aborted) return { cancelled: { completedUnits: [] } };

  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  const dedupe = makeSpanDeduper();
  // Seeded from what an earlier attempt already counted for this unit, so a
  // resumed job's terminal record describes the document rather than the
  // remainder it happened to run.
  const prior = resumeCursors?.['highlighting'];
  let found = prior?.found ?? 0;
  let created = prior?.emitted ?? 0;
  let errors = prior?.errors ?? 0;
  /** Where the walk stands: the offset its next chunk starts at. */
  let next = prior?.next ?? 0;
  await AnnotationDetection.detectHighlights(
    content, offsets, inferenceClient, logger, signal, params.instructions, params.density, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band. Both are
    // offsets: how far through the content, of its length, in code points.
    (consumedChars, totalChars) => onProgress(30 + Math.round((consumedChars / totalChars) * 30), { code: 'analyzing' }, echo),
    resumeCursors?.['highlighting'],
    async (matches, cursor, dropped) => {
      found += matches.length + dropped;
      errors += dropped;
      // Highlights carry no body — motivation:'highlighting' on a target
      // is a complete annotation per the W3C Web Annotation Model.
      const fresh = dedupe(matches.map((h) => buildAnnotation('highlighting', h)));
      created += fresh.length;
      onProgress(60, { code: 'creating-annotations', count: created }, echo);
      // One motivation per job, so exactly one unit — and with only one, a
      // unit-grain checkpoint could record nothing until the whole document
      // was done. The cursor is the entire resume story for these three types.
      await onChunkComplete(fresh, { unit: 'highlighting', cursor: { ...cursor, found, emitted: created, errors } });
      next = cursor.next;
    },
  );

  // A cancelled job reports no completion, whether or not anything was left to do.
  if (signal.aborted) return stoppedAt('highlighting', next, offsets);

  onProgress(100, { code: 'complete-created', count: created, motivation: params.motivation }, echo);

  return {
    result: detected(found, created, errors),
  };
}

/**
 * The user's own inputs, echoed back for the progress widget. Labels are CODES
 * (the client localizes them); values are the user's words and are shown
 * verbatim. Absent or blank inputs are omitted rather than rendered as empty
 * rows — "Instructions:" with nothing after it is noise, not information.
 *
 * Returned as the `extra` object rather than a bare array because every
 * `onProgress` in the run passes it: `progress$` REPLACES its value per event
 * (mark-state-unit), so a field sent once would flash at 10% and disappear.
 * The parameters describe the whole run, so every event carries them — the
 * same convention `processReferenceJob` follows for its entity types.
 */
function detectionEcho(p: {
  instructions?: string;
  tone?: string;
  density?: number;
}): Partial<JobProgress> {
  const requestParams: Array<{ label: 'instructions' | 'tone' | 'density'; value: string }> = [];
  if (p.instructions?.trim()) requestParams.push({ label: 'instructions', value: p.instructions.trim() });
  if (p.tone?.trim()) requestParams.push({ label: 'tone', value: p.tone.trim() });
  if (p.density !== undefined) requestParams.push({ label: 'density', value: String(p.density) });
  return requestParams.length > 0 ? { requestParams } : {};
}

export async function processCommentJob(
  content: string,
  /** The content's own conversions (`textOffsets(content)`), made once where the content is first held. */
  offsets: TextOffsets,
  inferenceClient: InferenceClient,
  params: HeldMarkParams<'commenting'>,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
  /** The held job's cancellation: the job stops after the chunk it is on, and reports nothing more. */
  signal: AbortSignal,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each unit, keyed the same way the checkpoint
   * is. A unit absent here starts at the top, which is every unit of a first
   * attempt. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobDetectionResult>> {
  // Cancelled before it began: nothing is asked, and nothing is reported.
  if (signal.aborted) return { cancelled: { completedUnits: [] } };

  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  // The body's `language` reflects the locale the LLM was asked to write in
  // (`params.language` — the user's UI locale). Defaults to 'en' when the
  // caller didn't specify, matching what the LLM produces by default.
  const bodyLanguage = params.language ?? 'en';
  const dedupe = makeSpanDeduper();
  // Seeded from what an earlier attempt already counted for this unit, so a
  // resumed job's terminal record describes the document rather than the
  // remainder it happened to run.
  const prior = resumeCursors?.['commenting'];
  let found = prior?.found ?? 0;
  let created = prior?.emitted ?? 0;
  let errors = prior?.errors ?? 0;
  /** Where the walk stands: the offset its next chunk starts at. */
  let next = prior?.next ?? 0;
  await AnnotationDetection.detectComments(
    content, offsets, inferenceClient, logger, signal, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band. Both are
    // offsets: how far through the content, of its length, in code points.
    (consumedChars, totalChars) => onProgress(30 + Math.round((consumedChars / totalChars) * 30), { code: 'analyzing' }, echo),
    resumeCursors?.['commenting'],
    async (comments, cursor, dropped) => {
      found += comments.length + dropped;
      errors += dropped;
      const fresh = dedupe(comments.map((c) =>
        // Format and language go on the body TextualBody: optional in the
        // schema, but consumers that do language-aware rendering rely on them.
        buildAnnotation('commenting', c, [
          { type: 'TextualBody', value: c.comment, purpose: 'commenting', format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
        ]),
      ));
      created += fresh.length;
      onProgress(60, { code: 'creating-annotations', count: created }, echo);
      await onChunkComplete(fresh, { unit: 'commenting', cursor: { ...cursor, found, emitted: created, errors } });
      next = cursor.next;
    },
  );

  // A cancelled job reports no completion, whether or not anything was left to do.
  if (signal.aborted) return stoppedAt('commenting', next, offsets);

  onProgress(100, { code: 'complete-created', count: created, motivation: params.motivation }, echo);

  return {
    result: detected(found, created, errors),
  };
}

export async function processAssessmentJob(
  content: string,
  /** The content's own conversions (`textOffsets(content)`), made once where the content is first held. */
  offsets: TextOffsets,
  inferenceClient: InferenceClient,
  params: HeldMarkParams<'assessing'>,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
  /** The held job's cancellation: the job stops after the chunk it is on, and reports nothing more. */
  signal: AbortSignal,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each unit, keyed the same way the checkpoint
   * is. A unit absent here starts at the top, which is every unit of a first
   * attempt. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobDetectionResult>> {
  // Cancelled before it began: nothing is asked, and nothing is reported.
  if (signal.aborted) return { cancelled: { completedUnits: [] } };

  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  const bodyLanguage = params.language ?? 'en';
  const dedupe = makeSpanDeduper();
  // Seeded from what an earlier attempt already counted for this unit, so a
  // resumed job's terminal record describes the document rather than the
  // remainder it happened to run.
  const prior = resumeCursors?.['assessing'];
  let found = prior?.found ?? 0;
  let created = prior?.emitted ?? 0;
  let errors = prior?.errors ?? 0;
  /** Where the walk stands: the offset its next chunk starts at. */
  let next = prior?.next ?? 0;
  await AnnotationDetection.detectAssessments(
    content, offsets, inferenceClient, logger, signal, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band. Both are
    // offsets: how far through the content, of its length, in code points.
    (consumedChars, totalChars) => onProgress(30 + Math.round((consumedChars / totalChars) * 30), { code: 'analyzing' }, echo),
    resumeCursors?.['assessing'],
    async (assessments, cursor, dropped) => {
      found += assessments.length + dropped;
      errors += dropped;
      const fresh = dedupe(assessments.map((a) =>
        // Single-object body with purpose aligned to motivation, matching the
        // majority of persisted assessments. Do not switch to an array or to
        // purpose='describing' — that loses the "this is an assessment, not
        // a description" signal and breaks existing readers that access
        // `body.value` directly on the object.
        buildAnnotation('assessing', a, {
          type: 'TextualBody', value: a.assessment, purpose: 'assessing', format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage,
        }),
      ));
      created += fresh.length;
      onProgress(60, { code: 'creating-annotations', count: created }, echo);
      await onChunkComplete(fresh, { unit: 'assessing', cursor: { ...cursor, found, emitted: created, errors } });
      next = cursor.next;
    },
  );

  // A cancelled job reports no completion, whether or not anything was left to do.
  if (signal.aborted) return stoppedAt('assessing', next, offsets);

  onProgress(100, { code: 'complete-created', count: created, motivation: params.motivation }, echo);

  return {
    result: detected(found, created, errors),
  };
}

/**
 * Reference detection checkpoints per UNIT — one entity type — through
 * `onUnitComplete`: only after the callback resolves does the unit count as
 * complete, and a retried claim skips the units recorded that way.
 * Annotations leave per chunk through `onChunkComplete`; the processor
 * returns only the result — returning the annotations as well would make a
 * post-run batch, where one failed call discards every completed unit's
 * work wholesale.
 *
 * A cancellation stops it after the chunk each unit in flight is on: a unit
 * whose last chunk that was is finished and checkpointed as any other, one
 * with text left is not, and no unit is begun.
 */
export async function processReferenceJob(
  content: string,
  /** The content's own conversions (`textOffsets(content)`), made once where the content is first held. */
  offsets: TextOffsets,
  inferenceClient: InferenceClient,
  params: HeldMarkParams<'linking'>,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
  /** The held job's cancellation: the job stops after the chunk it is on, and reports nothing more. */
  signal: AbortSignal,
  /**
   * The CHECKPOINT, fired once per unit after every one of its chunks has
   * committed. It carries no annotations — the effect already happened per
   * chunk through `onChunkComplete`, and a unit callback that also carried
   * them would be a second commit path.
   */
  onUnitComplete: (entityType: string) => Promise<void>,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each entity-type unit: the furthest it got,
   * and what it had counted there. A unit absent here starts at the top. A
   * finished unit's is where it ended. */
  resumeCursors?: Record<string, UnitCursor>,
  /** The entity types earlier attempts finished, as the claimed record names
   * them. They are not asked about again, and are counted by their cursors. */
  completedUnits?: readonly string[],
): Promise<ProcessorResult<JobDetectionResult>> {
  // Cancelled before it began: nothing is asked, and nothing is reported.
  if (signal.aborted) return { cancelled: { completedUnits: [] } };

  const entityTypeNames = params.entityTypes.map(String);
  const requestParams = [{ label: 'entity-types' as const, value: entityTypeNames.join(', ') }];
  const completedItems: CompletedItem[] = [];
  /** The units this attempt finished, in the order they finished: what a cancellation names. */
  const finishedUnits: string[] = [];
  // Seeded with what earlier attempts counted. A cursor is held for every
  // unit the job has begun, the units it finished among them, so the totals
  // are the whole job's from the first report.
  let totalFound = Object.values(resumeCursors ?? {}).reduce((n, c) => n + c.found, 0);
  let totalEmitted = Object.values(resumeCursors ?? {}).reduce((n, c) => n + c.emitted, 0);
  let errors = Object.values(resumeCursors ?? {}).reduce((n, c) => n + c.errors, 0);
  let totalUnderReportedPieces = 0;
  // The denominator: cumulative count-verifier expectations over accepted
  // pieces. Zero means no piece was priced — the frame then carries nothing.
  let totalExpected = 0;

  onProgress(10, { code: 'loading' }, { requestParams });

  const bodyLanguage = params.language ?? 'en';

  // Entity types run BOUNDED-CONCURRENT. They are independent units — own
  // extraction, own commit, own checkpoint — and a sequential `for … await`
  // uses a sliver of the provider's rate limit: nine types in sequence is
  // ≈ 2.5 h/document. The bound is the point: unbounded fan-out just trades
  // sequential waiting for 429 thrash.
  //
  // Shared counters and `completedItems` are mutated SYNCHRONOUSLY between
  // awaits inside the worker — safe under the single-threaded event loop (no
  // read-modify-write straddles an await), so no locking is needed. Progress is
  // "M of N done" rather than "on type i": concurrent types finish out of
  // order, and `completedItems` tolerates that.
  //
  // The types an earlier attempt finished are the job's all the same: they are
  // among the finished from the first report, in the job's order, each with
  // what its cursor counted. One the record holds no cursor for is finished,
  // and nothing says what it found: it is not listed.
  const finishedEarlier = entityTypeNames.filter((name) => completedUnits?.includes(name));
  for (const name of finishedEarlier) {
    const ended = resumeCursors?.[name];
    if (ended) completedItems.push({ value: name, foundCount: ended.found, persistedCount: ended.emitted });
  }
  let completed = finishedEarlier.length;
  const total = entityTypeNames.length;

  const emitTypeProgress = (entityTypeName: string): void => {
    const pct = 20 + Math.round((completed / total) * 60);
    onProgress(pct, { code: 'detecting-entities', entityType: entityTypeName }, {
      current: { kind: 'entity-type', value: entityTypeName },
      processed: completed,
      total,
      entitiesFound: totalFound,
      ...(totalExpected > 0 ? { entitiesExpected: totalExpected } : {}),
      entitiesEmitted: totalEmitted,
      completedItems: [...completedItems],
      requestParams,
    });
  };

  // Concurrency is the PROVIDER's capability, not a flat constant: a hosted
  // API parallelizes, a local single-model server does not. Reading it
  // from the client is what makes the same code correct on both.
  await runBounded(entityTypeNames.filter((name) => !finishedEarlier.includes(name)), inferenceClient.maxConcurrency, async (entityTypeName) => {
    if (!entityTypeName) return;
    // Cooperative cancellation: once aborted, a pending type is skipped when
    // its turn comes, and a type in flight stops after the chunk it is on.
    if (signal.aborted) return;

    emitTypeProgress(entityTypeName);

    // Unresolved reference body: the entity type as a tagging TextualBody,
    // stamped with the body locale to match the comment/assess/tag pattern.
    // The bind flow later appends a SpecificResource (purpose: 'linking') via
    // mark:body-updated to produce the resolved shape. Emitting an empty body
    // would break the append contract.
    const unresolvedBody: Annotation['body'] = [
      { type: 'TextualBody' as const, value: entityTypeName, purpose: 'tagging' as const, format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
    ];

    // One deduper per unit, held across its chunks.
    const dedupe = makeSpanDeduper();
    // Seeded from what earlier attempts already counted for THIS unit, so the
    // terminal record describes the document rather than the remainder this
    // attempt happened to run. Absent (a first attempt) means zero, which is
    // the truth rather than a default.
    const priorUnit = resumeCursors?.[entityTypeName];
    let unitFound = priorUnit?.found ?? 0;
    let unitPersisted = priorUnit?.emitted ?? 0;
    let unitErrors = priorUnit?.errors ?? 0;
    /** Where the unit's walk stands: the offset its next chunk starts at. */
    let unitNext = priorUnit?.next ?? 0;
    // What remains unknown at the unit's end: floor-accepted pieces, folded.
    let underReported: { pieces: number; found: number; counted: number } | undefined;
    await extractEntities(
      content, offsets, [entityTypeName], inferenceClient, params.includeDescriptiveReferences ?? false, logger, signal,
      params.sourceLanguage,
      // Liveness heartbeat: fires at chunk boundaries and every ~15 s while a
      // call is in flight, so a long single-chunk call is not silent. It
      // repeats the current position rather than inventing an advance — the
      // stall watchdog, janitor and client timeout need a signal, not a
      // monotone.
      () => emitTypeProgress(entityTypeName),
      (verdict) => {
        underReported = {
          pieces: (underReported?.pieces ?? 0) + 1,
          found: (underReported?.found ?? 0) + verdict.found,
          counted: (underReported?.counted ?? 0) + verdict.counted,
        };
      },
      (counted) => {
        totalExpected += counted;
        emitTypeProgress(entityTypeName);
      },
      resumeCursors?.[entityTypeName],
      async (chunkEntities, cursor, dropped) => {
        const built: Annotation[] = [];
        // A mention of another entity type than this unit's was proposed and
        // made nothing: it is counted with those whose text is nowhere.
        let chunkErrors = dropped;
        for (const entity of chunkEntities) {
          const reconciled = reconcile(content, {
            exact: entity.exact,
            ...(entity.prefix !== undefined ? { prefix: entity.prefix } : {}),
            ...(entity.suffix !== undefined ? { suffix: entity.suffix } : {}),
          });
          if (!reconciled) {
            logger.error('Entity dropped — text not found in source', {
              text: entity.exact,
              entityType: entity.entityType,
            });
            chunkErrors++;
            continue;
          }
          noteAnchor('reference', entity.exact, reconciled.anchorMethod, logger);
          built.push(buildAnnotation('linking', reconciled, unresolvedBody));
        }
        const fresh = dedupe(built);
        // What this chunk makes true ONCE IT IS DURABLE. Computed before the
        // commit because the checkpoint is written inside it and has to carry
        // the running totals — a checkpoint reporting only this attempt's share
        // would reset the count on every death — but assigned after, so the
        // invariant below still holds.
        const chunkFound = chunkEntities.length + dropped;
        const nextFound = unitFound + chunkFound;
        const nextEmitted = unitPersisted + fresh.length;
        const nextErrors = unitErrors + chunkErrors;
        // Awaited: a failed commit fails the unit before it can checkpoint;
        // the cursor rides with it so the checkpoint trails the log by
        // construction rather than by the caller remembering to order them.
        await onChunkComplete(fresh, {
          unit: entityTypeName,
          cursor: { ...cursor, found: nextFound, emitted: nextEmitted, errors: nextErrors },
        });
        // Tallies move only PAST the awaited commit — a chunk that fails to
        // commit contributes nothing anywhere — and the numerator advances at
        // the same grain as the denominator: per chunk, in the same frame
        // family the viewer's found-of-~expected tally reads.
        unitFound = nextFound;
        unitPersisted = nextEmitted;
        unitErrors = nextErrors;
        unitNext = cursor.next;
        totalFound += chunkFound;
        totalEmitted += fresh.length;
        errors += chunkErrors;
        // A cancelled job has stopped with this chunk's checkpoint, and says nothing after it.
        if (!signal.aborted) emitTypeProgress(entityTypeName);
      },
    );

    // A cancellation stopped the unit with text left: it is not finished.
    if (signal.aborted && unitNext < offsets.length) return;

    // Every chunk of this unit is durable; only now may it checkpoint.
    await onUnitComplete(entityTypeName);
    finishedUnits.push(entityTypeName);
    // Found vs persisted, per unit — the gap between them is this flow's yield.
    completedItems.push({
      value: entityTypeName,
      foundCount: unitFound,
      persistedCount: unitPersisted,
      ...(underReported ? { underReported } : {}),
    });
    if (underReported) totalUnderReportedPieces += underReported.pieces;
    completed++;
    if (!signal.aborted) emitTypeProgress(entityTypeName);
  });

  // A cancelled job reports no completion, whether or not anything was left to do.
  if (signal.aborted) return { cancelled: { completedUnits: finishedUnits } };

  // The terminal frame carries the completed set — each unit's found and
  // persisted counts, the run's yield.
  onProgress(100, { code: 'complete-created', count: totalEmitted, motivation: params.motivation }, {
    ...(totalExpected > 0 ? { entitiesExpected: totalExpected } : {}),
    completedItems: [...completedItems],
    requestParams,
  });

  return {
    result: {
      ...detected(totalFound, totalEmitted, errors),
      ...(totalUnderReportedPieces > 0 ? { underReportedPieces: totalUnderReportedPieces } : {}),
    },
  };
}

export async function processTagJob(
  content: string,
  /** The content's own conversions (`textOffsets(content)`), made once where the content is first held. */
  offsets: TextOffsets,
  inferenceClient: InferenceClient,
  params: HeldMarkParams<'tagging'>,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
  /** The held job's cancellation: the job stops after the chunk it is on, and reports nothing more. */
  signal: AbortSignal,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each CATEGORY — a tag job's units are its
   * categories, not its motivation: each walks the whole document, so one
   * shared cursor would skip text for all but one of them. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobDetectionResult>> {
  // Cancelled before it began: nothing is asked, and nothing is reported.
  if (signal.aborted) return { cancelled: { completedUnits: [] } };

  onProgress(10, { code: 'loading' });
  onProgress(30, { code: 'analyzing-tags' });

  const bodyLanguage = params.language ?? 'en';
  // One deduper across every category: they share an emission stream, and
  // the key includes the body, so only true repeats collapse.
  const dedupe = makeSpanDeduper();
  // Resumed tallies — seeded from the checkpoint so the terminal record
  // describes the whole document — and they are seeded DIFFERENTLY because
  // they accumulate differently. `found` and `errors` sum each category's own running
  // total at the end of that category, and those totals are already seeded —
  // seeding here too would count the earlier attempt twice. `created`
  // accumulates per chunk from this attempt only, so it must start at what
  // earlier attempts committed.
  let found = 0;
  let errors = 0;
  let created = Object.values(resumeCursors ?? {}).reduce((n, c) => n + c.emitted, 0);
  // byCategory counts the DEDUPED set so the per-category counts match what
  // is actually stored. The category is the first (tagging) TextualBody.
  const byCategory: Record<string, number> = {};
  const completedItems: CompletedItem[] = [];
  /** The categories whose walk reached the end of the text: what a cancellation names. */
  const finishedUnits: string[] = [];

  for (let c = 0; c < params.categories.length; c++) {
    const category = params.categories[c]!;
    // Reports `current` and its position, like every other counting flow.
    const position = () => ({
      current: { kind: 'category' as const, value: category },
      processed: c,
      total: params.categories.length,
      completedItems: [...completedItems],
    });
    onProgress(
      30 + Math.round((c / params.categories.length) * 30),
      { code: 'analyzing-tags' },
      position(),
    );
    // This category's own running tallies, seeded from its cursor so the
    // checkpoint it writes stays continuable for a third attempt.
    const priorCategory = resumeCursors?.[category];
    let categoryFound = priorCategory?.found ?? 0;
    let categoryCreated = priorCategory?.emitted ?? 0;
    let categoryErrors = priorCategory?.errors ?? 0;
    // What earlier attempts committed for this category is in the count by
    // category, as it is in `created`. Set once: a category the job names
    // twice is walked twice, and its cursor counted once.
    if (categoryCreated > 0) byCategory[category] ??= categoryCreated;
    /** Where the category's walk stands: the offset its next chunk starts at. */
    let categoryNext = priorCategory?.next ?? 0;
    await AnnotationDetection.detectTags(
      content, offsets, inferenceClient, logger, signal, params.schema, category, params.sourceLanguage,
      // Liveness (chunk boundaries + in-flight heartbeat): this category's
      // slice of the 30–60 band.
      (consumedChars, totalChars) => onProgress(
        30 + Math.round(((c + consumedChars / totalChars) / params.categories.length) * 30),
        { code: 'analyzing-tags' },
        position(),
      ),
      resumeCursors?.[category],
      async (matches, cursor, dropped) => {
        categoryFound += matches.length + dropped;
        categoryErrors += dropped;
        const fresh = dedupe(matches.map((t) => {
          // Two-body shape, matching every persisted tag annotation: the
          // category as a tagging TextualBody, plus the tagging-schema id as a
          // classifying TextualBody. The classifying body is the only trace of
          // schema provenance in the event log — do not drop it.
          return buildAnnotation('tagging', t, [
            { type: 'TextualBody', value: t.category,       purpose: 'tagging',     format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
            { type: 'TextualBody', value: params.schema.id, purpose: 'classifying', format: 'text/plain' satisfies SupportedMediaType },
          ]);
        }));
        created += fresh.length;
        for (const ann of fresh) {
          const body = (ann as { body?: Array<{ value?: unknown }> }).body;
          const cat = Array.isArray(body) && typeof body[0]?.value === 'string' ? body[0].value : 'unknown';
          byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        }
        onProgress(60, { code: 'creating-tag-annotations', count: created });
        // The unit is the CATEGORY, not the motivation. A tagging job loops
        // over `params.categories`, each walking the whole document from zero,
        // so a single 'tagging' key would have every category overwriting one
        // cursor — and the monotone merge would keep the furthest, which is the
        // right answer for at most one of them and silently skips text for the
        // rest. Same shape as reference's entity types, for the same reason.
        categoryCreated += fresh.length;
        await onChunkComplete(fresh, {
          unit: category,
          cursor: { ...cursor, found: categoryFound, emitted: categoryCreated, errors: categoryErrors },
        });
        categoryNext = cursor.next;
      },
    );
    if (categoryNext >= offsets.length) finishedUnits.push(category);
    // A cancelled job begins no other category, and reports no completion.
    if (signal.aborted) return { cancelled: { completedUnits: finishedUnits } };
    found += categoryFound;
    errors += categoryErrors;
    completedItems.push({ value: category, foundCount: categoryFound });
  }

  onProgress(100, { code: 'complete-created', count: created, motivation: params.motivation });

  return {
    result: { ...detected(found, created, errors), byCategory },
  };
}

/**
 * Output bound, symmetric with the extraction budget and deliberately the
 * SAME threshold: an artifact larger than what extraction accepts would be a
 * resource our own Smelter declines as 'too-large'. One judgment, two
 * enforcement points. A runaway generation fails loudly (job:fail); it never
 * uploads.
 */
export function assertWithinOutputBudget(byteLength: number): void {
  if (!withinByteBudget(byteLength)) {
    throw new Error(
      `Generated artifact exceeds the output byte budget: ${byteLength} bytes > ${MAX_PDF_BYTES}. Refusing a runaway generation.`,
    );
  }
}

/** What a `yield` job made: the artifact to upload, and the claims in it to cite. */
export interface GeneratedArtifact {
  content: Uint8Array;
  title: string;
  format: SupportedMediaType;
  citations: GenerationCitation[];
  truncated: boolean;
}

/**
 * `signal` is the held job's cancellation. A `yield` job stops before it
 * uploads: once its model has answered, a cancellation that has arrived by
 * then ends the job with nothing made of the answer and nothing more
 * reported. The request to the provider is not aborted when a cancellation
 * arrives: the generation under way runs to its answer, or to its own
 * ten-minute bound, and the job stops then.
 *
 * What it returns is the artifact, and not the job's result: a generation has
 * no result to state before its resource exists.
 */
export async function processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationJobParams,
  onProgress: OnProgress,
  logger: Logger,
  signal: AbortSignal,
): Promise<GeneratedArtifact | { cancelled: true }> {
  // Refuse any requested media type the registry doesn't mark `generatable` —
  // loudly (the throw propagates as job:fail), never a silent markdown fallback
  // under a mislabeled format. The gate reads the registry capability, not a
  // local table. Validate before the LLM call. No attempt changes what this
  // worker generates, so the refusal skips the retry budget.
  const outputMediaType: SupportedMediaType = params.outputMediaType ?? 'text/markdown';
  if (!GENERATABLE_MEDIA_TYPES.includes(outputMediaType)) {
    throw new DeterministicJobError(
      `Unsupported outputMediaType for generation: ${outputMediaType}. Generation produces ${GENERATABLE_MEDIA_TYPES.join(' or ')}.`,
    );
  }
  const stopped = { cancelled: true } as const;

  const title = params.title;
  const entityTypes = (params.entityTypes ?? []).map(String);

  // PDF path: the model authors Typst; the worker's pinned binary compiles it,
  // with the legible compile errors fed back for a bounded number of repairs.
  // Citations on PDFs need page geometry, not text offsets — the worker finds
  // each claim in the generated PDF's own text layer and anchors it there,
  // rather than minting selectors that would render nothing.
  if (outputMediaType === 'application/pdf') {
    onProgress(5, { code: 'generating-resource' });

    // Under `cite`, [[<id>]] tokens are stripped from the SOURCE before every
    // compile — they must never render into the artifact. The citations carry
    // the claim text; the worker re-anchors it by page geometry after
    // extraction. Offsets in these citations count the Typst source's code
    // points and are NOT used for PDF anchoring.
    const citable = params.cite === true ? collectCitableIds(params.context) : null;

    let generated = await generateResourceFromTopic(
      title, entityTypes, inferenceClient, logger,
      params.prompt, params.language, params.context, params.temperature,
      params.maxTokens, params.sourceLanguage, outputMediaType,
      params.task, params.structure, params.cite,
    );
    if (signal.aborted) return stopped;
    let source = generated.content;
    let citations: GenerationCitation[] = [];
    if (citable) {
      const resolved = resolveCitationTokens(generated.content, citable, logger);
      source = resolved.content;
      citations = resolved.citations;
    }
    let compiled = compileTypst(source);
    let repairs = 0;
    while ('error' in compiled) {
      // A truncated source that fails to compile is cut off, not wrong —
      // every repair regenerates under the same ceiling and cannot restore
      // content that was never generated. Fail immediately with the actual
      // cause instead of burning the repair budget and blaming the compiler.
      if (generated.truncated) {
        throw new Error(
          `Generation stopped at the maxTokens ceiling (${params.maxTokens ?? DEFAULT_MAX_TOKENS} tokens) and the cut-off Typst source does not compile — repair cannot help; raise maxTokens. Compile error: ${compiled.error}`,
        );
      }
      if (repairs >= MAX_COMPILE_REPAIRS) {
        throw new Error(
          `Typst compilation failed after ${MAX_COMPILE_REPAIRS} repair attempts: ${compiled.error}`,
        );
      }
      repairs++;
      logger.warn('Typst compile failed — feeding the error back for repair', {
        attempt: repairs,
        error: compiled.error.slice(0, 500),
      });
      generated = await generateResourceFromTopic(
        title, entityTypes, inferenceClient, logger,
        params.prompt, params.language, params.context, params.temperature,
        params.maxTokens, params.sourceLanguage, outputMediaType,
        params.task, params.structure, params.cite,
        { source, error: compiled.error },
      );
      if (signal.aborted) return stopped;
      if (citable) {
        const resolved = resolveCitationTokens(generated.content, citable, logger);
        source = resolved.content;
        citations = resolved.citations;
      } else {
        source = generated.content;
      }
      compiled = compileTypst(source);
    }

    assertWithinOutputBudget(compiled.pdf.byteLength);
    onProgress(95, { code: 'creating-resource' });
    // The producer owns terminality: without this, the client's last frame is
    // forever the 95% payload. Generic by design — the outcome (name + link)
    // travels on job:complete. `truncated` rides both surfaces, this event and
    // the job's result: truncation that lands at a syntactic boundary still
    // compiles, and the artifact is still cut off.
    onProgress(100, { code: 'complete-generated', truncated: generated.truncated });

    return {
      content: compiled.pdf,
      title,
      format: outputMediaType,
      citations,
      truncated: generated.truncated,
    };
  }

  // Generation has exactly two observable transitions: the LLM call starting
  // ('generating') and content finalized / creation beginning ('creating').
  // There is no fetch — context arrives pre-gathered in params. Percentages
  // approximate the share of expected wall-clock complete at each transition
  // (a single atomic LLM call has no measurable progress, and inference
  // dominates the job): its start is ~5, its end ~95.
  onProgress(5, { code: 'generating-resource' });

  const generated = await generateResourceFromTopic(
    title,
    entityTypes,
    inferenceClient,
    logger,
    params.prompt,
    params.language,
    params.context,
    params.temperature,
    params.maxTokens,
    params.sourceLanguage,
    outputMediaType,
    params.task,
    params.structure,
    params.cite,
  );
  if (signal.aborted) return stopped;

  // Under `cite`, the model emitted [[<id>]] transport tokens — resolve them:
  // validate against the ids the context actually contained, strip from the
  // stored content, and carry claim-span citations for the worker to mint.
  // When cite is off, bracketed text is legitimate content — leave it alone.
  let content = generated.content;
  let citations: GenerationCitation[] = [];
  if (params.cite === true) {
    const resolved = resolveCitationTokens(content, collectCitableIds(params.context), logger);
    content = resolved.content;
    citations = resolved.citations;
  }

  onProgress(95, { code: 'creating-resource' });

  // The artifact is bytes; text is an encoding of them. One shape for every
  // output media type, so a string can never travel mislabeled as a binary
  // format. Citation offsets count the decoded text's code points.
  const artifact = new TextEncoder().encode(content);
  assertWithinOutputBudget(artifact.byteLength);

  // The producer owns terminality: without this, the client's last frame is
  // forever the 95% payload. Generic by design — the outcome (name + link)
  // travels on job:complete. `truncated` rides both surfaces: the event is the
  // frame the client renders, and the worker states it in the job's result
  // once the resource exists.
  onProgress(100, { code: 'complete-generated', truncated: generated.truncated });

  return {
    content: artifact,
    title,
    format: outputMediaType,
    citations,
    truncated: generated.truncated,
  };
}
