/**
 * Job Processors
 *
 * Pure functions that take content + inference client + params,
 * report progress via callback, and return annotations + results.
 *
 * No EventBus, no JobQueue, no side effects except calling inference.
 * Driven by the remote worker process (worker-process.ts), which claims
 * jobs over SSE and dispatches by jobType to these functions.
 */

import { AnnotationDetection } from './workers/annotation-detection';
import { extractEntities } from './workers/detection/entity-extractor';
import { DEFAULT_MAX_TOKENS, generateResourceFromTopic } from './workers/generation/resource-generation';
import { compileTypst, MAX_COMPILE_REPAIRS } from './workers/generation/typst-compiler';
import { withinByteBudget, MAX_PDF_BYTES } from '@semiont/content';
import { resolveCitationTokens, collectContextResourceIds, type GenerationCitation } from './workers/generation/citation-resolver';
import { annotationIdFor } from '@semiont/event-sourcing';
import { didToAgent, GENERATABLE_MEDIA_TYPES, type Annotation, type GenerationJobParams, type Logger, type ResourceId, type SupportedMediaType, type components, type JobReferenceAnnotationResult, type JobHighlightAnnotationResult, type JobCommentAnnotationResult, type JobAssessmentAnnotationResult, type JobTagAnnotationResult, type UnitCursor } from '@semiont/core';
import { reconcileSelector, createFragmentSelector, locate, type ReconciledSelector, type AnchoredText } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type {
  HighlightDetectionParams,
  CommentDetectionParams,
  AssessmentDetectionParams,
  DetectionParams,
  TagDetectionParams,
  GenerationResult,
} from './types';
import { noteAnchor } from './workers/detection/anchor-audit';
import { runBounded } from './workers/detection/bounded-concurrency';

type Agent = components['schemas']['Agent'];

/** A detected span — offsets into the extracted `.text`, plus optional context. */
export type SpanMatch = { exact: string; start: number; end: number; prefix?: string; suffix?: string };

/**
 * The span half of an annotation's identity (JOB-RESTART-SAFETY P3).
 *
 * Shared by both builders because the span IS the same fact in both — the PDF
 * path additionally persists geometry for it, but that geometry is derived
 * from these offsets, so hashing it too would add no distinguishing power and
 * would make an id depend on a layout the text path cannot reproduce.
 *
 * `exact` is included, not just the offsets: after a content update the same
 * offsets cover different text, and that is a different annotation.
 */
function spanAnchor(match: Pick<SpanMatch, 'start' | 'end' | 'exact'>): string {
  return `${match.start}:${match.end}:${match.exact}`;
}

/**
 * Turn a detected span into a stored annotation. The media type, resource, and
 * attribution context are closed over by the caller (see `prepareDetection`);
 * the detection processor supplies only the motivation, the span, and any
 * motivation-specific body. This is the single axis that varies by media type,
 * so the detection processors themselves stay media-agnostic.
 */
export type BuildAnnotation = (
  motivation: Motivation,
  match: SpanMatch,
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
 * `message` is a CODE plus typed params, never a prose sentence
 * (ASSIST-PROGRESS-CONSOLIDATION A6). The producer reports what happened;
 * each client renders it in the user's language — react-ui from its 29
 * locales, the Go launcher from its English map. The vocabulary is frozen
 * by the census of these call sites: adding a shape means adding a variant
 * to `JobProgressMessage.json` and copy in every client, not composing a
 * new sentence here.
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
 * A detection processor returns only its result. Annotations leave through
 * `onChunkComplete`, per chunk — a return that also carried them would be a
 * second path to the same write.
 */
export interface ProcessorResult<R> {
  result: R;
}

/**
 * Strip the audit-only fields (`anchorMethod`, `llmOffsets`, `matchQuality`)
 * off a `ReconciledSelector` so the rest is shaped like a match input for
 * `buildTextAnnotation`. The audit info belongs in logs, not in storage.
 */
function toMatch(r: ReconciledSelector): { exact: string; start: number; end: number; prefix?: string; suffix?: string } {
  return {
    exact: r.exact,
    start: r.start,
    end: r.end,
    ...(r.prefix !== undefined ? { prefix: r.prefix } : {}),
    ...(r.suffix !== undefined ? { suffix: r.suffix } : {}),
  };
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
  // TextPositionSelector (durable char offsets). PDF annotations have none —
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
 * Drop annotations that are identical in the fields that define an
 * annotation's meaning: motivation, anchored span, and body.
 *
 * Why this is needed: each LLM-emitted span is reconciled independently
 * (no cross-entry coordination), and `reconcileSelector`'s `first-of-many`
 * fallback anchors every undisambiguated entry at the *same* first
 * occurrence. So a phrase repeated in non-distinctive context can produce
 * several entries that all collapse onto one span — identical events. This
 * collapses them back to one.
 *
 * What it does NOT drop: same span, *different* body (e.g. the same text
 * tagged as two entity types, or two distinct comments on one passage).
 * Those are legitimately distinct annotations.
 *
 * Applied identically by every processor below.
 */
/**
 * THE dedupe decider — one mechanism for all five detection types, held
 * across a stream of chunk batches: adjacent chunks overlap, so the same
 * span arrives twice, and there is no post-pass to collapse it in. Scope it
 * to one emission stream — per unit for reference detection, per job for the
 * four motivations. Never add a batch post-pass beside it (gated).
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

export function buildTextAnnotation(
  content: string,
  resourceId: ResourceId,
  userId: string,
  generator: Agent,
  motivation: Motivation,
  match: { exact: string; start: number; end: number; prefix?: string; suffix?: string },
  // Body may be a single AnnotationBody object or a non-empty array of
  // them, OR omitted entirely. W3C treats body as optional; annotations
  // whose motivation alone conveys meaning (highlighting) legitimately
  // skip it. Every other motivation currently passes something; the
  // processor that calls this makes the choice per-motivation.
  body?: Annotation['body'],
) {
  // Write-time invariant. Every selector that reaches storage must be
  // internally consistent with the source content. If a worker bypasses
  // `reconcileSelector` or a future change re-introduces overlap, the
  // throw fires loudly here instead of corrupting the KB.
  if (content.substring(match.start, match.end) !== match.exact) {
    throw new Error(
      `buildTextAnnotation invariant: content.substring(${match.start}, ${match.end}) !== exact ` +
        `for resource ${resourceId}, motivation ${motivation}`,
    );
  }
  if (match.prefix !== undefined) {
    const actualPrefix = content.substring(Math.max(0, match.start - match.prefix.length), match.start);
    if (actualPrefix !== match.prefix) {
      throw new Error(
        `buildTextAnnotation invariant: content prefix-slice !== prefix ` +
          `for resource ${resourceId}, motivation ${motivation}`,
      );
    }
  }
  if (match.suffix !== undefined) {
    const actualSuffix = content.substring(match.end, Math.min(content.length, match.end + match.suffix.length));
    if (actualSuffix !== match.suffix) {
      throw new Error(
        `buildTextAnnotation invariant: content suffix-slice !== suffix ` +
          `for resource ${resourceId}, motivation ${motivation}`,
      );
    }
  }

  // `userId` here is the DID of the human who initiated the work. The
  // worker process is acting on their behalf using `generator` to
  // produce content. Per the protocol attribution model:
  //   creator        = who initiated (the human)
  //   generator      = what produced (the software peer)
  //   wasAttributedTo = both parties (PROV-O)
  // For autonomous-agent work creator and generator collapse to the
  // same Software Agent; the same field assignments still hold.
  const creator = didToAgent(userId);
  const wasAttributedTo: Agent[] =
    creator['@id'] === generator['@id'] ? [generator] : [creator, generator];
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    'type': 'Annotation' as const,
    'id': annotationIdFor({ resourceId: resourceId as string, motivation, anchor: spanAnchor(match), body }),
    motivation,
    creator,
    generator,
    wasAttributedTo,
    created: new Date().toISOString(),
    target: {
      type: 'SpecificResource' as const,
      source: resourceId as string,
      selector: [
        { type: 'TextPositionSelector' as const, start: match.start, end: match.end },
        {
          type: 'TextQuoteSelector' as const,
          exact: match.exact,
          ...(match.prefix && { prefix: match.prefix }),
          ...(match.suffix && { suffix: match.suffix }),
        },
      ],
    },
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * PDF sibling of `buildTextAnnotation`. The model returns the same
 * `{ exact, start, end, prefix?, suffix? }` match over the extracted text
 * layer's `text`; geometry comes from the layer, never the model.
 *
 * `target.selector` = one `FragmentSelector` per line (`locate` unions the
 * overlapping text-layer items into per-line viewrects) plus a
 * `TextQuoteSelector` anchor. No `TextPositionSelector`: the extracted text
 * layer is a derived artifact, not the stored content, so its char offsets are
 * not a durable anchor.
 *
 * Write-time invariant (geometry <-> text): geometry is item-level (word runs),
 * so the covered items' text must *contain* `exact` (whitespace-normalized) —
 * containment, not reconstruction. An empty cover (no overlapping items -> no
 * rects) also fails. Throws loudly, naming the resource + motivation, rather
 * than persisting geometry that doesn't back the quoted text.
 */
export function buildPdfAnnotation(
  anchored: AnchoredText,
  resourceId: ResourceId,
  userId: string,
  generator: Agent,
  motivation: Motivation,
  match: { exact: string; start: number; end: number; prefix?: string; suffix?: string },
  body?: Annotation['body'],
) {
  // `locate` returns both the per-line rects and the overlap items it found;
  // reuse `overlap` for the containment check rather than re-scanning layer.items.
  const { rects, overlap } = locate(anchored, match.start, match.end);

  const coveredText = overlap.length
    ? anchored.text.substring(
        Math.min(...overlap.map((i) => i.start)),
        Math.max(...overlap.map((i) => i.end)),
      )
    : '';
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  // Two distinct failures, reported distinctly. Merged, both printed "covered
  // text does not contain exact" — which sends anyone debugging an empty cover
  // to inspect text matching that never ran. Same class deliberately: both stay
  // plain `Error`, so `classifyFailure` leaves them unrecognized and therefore
  // retryable (ABANDONED-INFERENCE HD2 is one-sided — only KNOWN-deterministic
  // failures skip the budget). No rects LOOKS deterministic, but the stored map
  // is keyed by content checksum, so a retry after the bytes change reads a
  // different map and can legitimately succeed.
  if (rects.length === 0) {
    throw new Error(
      `buildPdfAnnotation invariant: no rects located for offsets ${match.start}-${match.end} ` +
        `for resource ${resourceId}, motivation ${motivation}`,
    );
  }
  if (!normalize(coveredText).includes(normalize(match.exact))) {
    throw new Error(
      `buildPdfAnnotation invariant: covered text does not contain exact ` +
        `for resource ${resourceId}, motivation ${motivation}`,
    );
  }

  const creator = didToAgent(userId);
  const wasAttributedTo: Agent[] =
    creator['@id'] === generator['@id'] ? [generator] : [creator, generator];

  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    'type': 'Annotation' as const,
    'id': annotationIdFor({ resourceId: resourceId as string, motivation, anchor: spanAnchor(match), body }),
    motivation,
    creator,
    generator,
    wasAttributedTo,
    created: new Date().toISOString(),
    target: {
      type: 'SpecificResource' as const,
      source: resourceId as string,
      selector: [
        ...rects.map((coord) => ({
          type: 'FragmentSelector' as const,
          conformsTo: 'http://tools.ietf.org/rfc/rfc3778' as const,
          value: createFragmentSelector(coord),
        })),
        {
          type: 'TextQuoteSelector' as const,
          exact: match.exact,
          ...(match.prefix && { prefix: match.prefix }),
          ...(match.suffix && { suffix: match.suffix }),
        },
      ],
    },
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * Where one unit stands once the chunk just handed over is durable
 * (CHUNK-GRAIN-RESUME P2).
 *
 * The unit is named HERE rather than in the detection layer, which knows about
 * chunks and nothing about jobs: for `reference-annotation` a unit is an entity
 * type, for `tag-annotation` a category — both loop over several — and for the
 * other three the job runs exactly one unit, its own motivation.
 */
export interface UnitCheckpoint {
  unit: string;
  cursor: UnitCursor;
}

export async function processHighlightJob(
  content: string,
  inferenceClient: InferenceClient,
  params: HighlightDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each unit (CHUNK-GRAIN-RESUME P3), keyed the
   * same way the checkpoint is. A unit absent here starts at the top, which is
   * every unit of a first attempt. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobHighlightAnnotationResult>> {
  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  const dedupe = makeSpanDeduper();
  // Seeded from what an earlier attempt already counted for this unit, so a
  // resumed job's terminal record describes the document rather than the
  // remainder it happened to run (CHUNK-GRAIN-RESUME HD3).
  const prior = resumeCursors?.['highlighting'];
  let found = prior?.found ?? 0;
  let created = prior?.emitted ?? 0;
  await AnnotationDetection.detectHighlights(
    content, inferenceClient, params.instructions, params.density, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band.
    (consumedChars, totalChars) => onProgress(30 + Math.round((consumedChars / totalChars) * 30), { code: 'analyzing' }, echo),
    resumeCursors?.['highlighting'],
    async (matches, cursor) => {
      found += matches.length;
      // Highlights carry no body — motivation:'highlighting' on a target
      // is a complete annotation per the W3C Web Annotation Model.
      const fresh = dedupe(matches.map((h) => buildAnnotation('highlighting', h)));
      created += fresh.length;
      onProgress(60, { code: 'creating-annotations', count: created }, echo);
      // One motivation per job, so exactly one unit — and with only one, a
      // unit-grain checkpoint could record nothing until the whole document
      // was done. The cursor is the entire resume story for these three types.
      await onChunkComplete(fresh, { unit: 'highlighting', cursor: { ...cursor, found, emitted: created } });
    },
  );

  onProgress(100, { code: 'complete-created', count: created, kind: 'highlight' }, echo);

  return {
    result: { kind: 'highlight-annotation', highlightsFound: found, highlightsCreated: created },
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
 * same convention `processReferenceJob` already follows for its entity types.
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
  inferenceClient: InferenceClient,
  params: CommentDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each unit (CHUNK-GRAIN-RESUME P3), keyed the
   * same way the checkpoint is. A unit absent here starts at the top, which is
   * every unit of a first attempt. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobCommentAnnotationResult>> {
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
  // remainder it happened to run (CHUNK-GRAIN-RESUME HD3).
  const prior = resumeCursors?.['commenting'];
  let found = prior?.found ?? 0;
  let created = prior?.emitted ?? 0;
  await AnnotationDetection.detectComments(
    content, inferenceClient, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band.
    (consumedChars, totalChars) => onProgress(30 + Math.round((consumedChars / totalChars) * 30), { code: 'analyzing' }, echo),
    resumeCursors?.['commenting'],
    async (comments, cursor) => {
      found += comments.length;
      const fresh = dedupe(comments.map((c) =>
        // Match the pre-#651 CommentAnnotationWorker: include format and
        // language on the body TextualBody. Optional in the schema, but
        // consumers that do language-aware rendering rely on them.
        buildAnnotation('commenting', c, [
          { type: 'TextualBody', value: c.comment, purpose: 'commenting', format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
        ]),
      ));
      created += fresh.length;
      onProgress(60, { code: 'creating-annotations', count: created }, echo);
      await onChunkComplete(fresh, { unit: 'commenting', cursor: { ...cursor, found, emitted: created } });
    },
  );

  onProgress(100, { code: 'complete-created', count: created, kind: 'comment' }, echo);

  return {
    result: { kind: 'comment-annotation', commentsFound: found, commentsCreated: created },
  };
}

export async function processAssessmentJob(
  content: string,
  inferenceClient: InferenceClient,
  params: AssessmentDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each unit (CHUNK-GRAIN-RESUME P3), keyed the
   * same way the checkpoint is. A unit absent here starts at the top, which is
   * every unit of a first attempt. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobAssessmentAnnotationResult>> {
  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  const bodyLanguage = params.language ?? 'en';
  const dedupe = makeSpanDeduper();
  // Seeded from what an earlier attempt already counted for this unit, so a
  // resumed job's terminal record describes the document rather than the
  // remainder it happened to run (CHUNK-GRAIN-RESUME HD3).
  const prior = resumeCursors?.['assessing'];
  let found = prior?.found ?? 0;
  let created = prior?.emitted ?? 0;
  await AnnotationDetection.detectAssessments(
    content, inferenceClient, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band.
    (consumedChars, totalChars) => onProgress(30 + Math.round((consumedChars / totalChars) * 30), { code: 'analyzing' }, echo),
    resumeCursors?.['assessing'],
    async (assessments, cursor) => {
      found += assessments.length;
      const fresh = dedupe(assessments.map((a) =>
        // Single-object body with purpose aligned to motivation, matching the
        // pre-#651 AssessmentAnnotationWorker's shape and the majority of
        // persisted assessments. Do not switch to an array or to
        // purpose='describing' — that loses the "this is an assessment, not
        // a description" signal and breaks existing readers that access
        // `body.value` directly on the object.
        buildAnnotation('assessing', a, {
          type: 'TextualBody', value: a.assessment, purpose: 'assessing', format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage,
        }),
      ));
      created += fresh.length;
      onProgress(60, { code: 'creating-annotations', count: created }, echo);
      await onChunkComplete(fresh, { unit: 'assessing', cursor: { ...cursor, found, emitted: created } });
    },
  );

  onProgress(100, { code: 'complete-created', count: created, kind: 'assessment' }, echo);

  return {
    result: { kind: 'assessment-annotation', assessmentsFound: found, assessmentsCreated: created },
  };
}

/**
 * Reference detection commits per UNIT — one entity type — through
 * `onUnitComplete` (ABANDONED-INFERENCE P2, checkpointed resume): the
 * callback receives the unit's deduped annotations, and only after it
 * resolves does the unit count as complete. Emission belongs to the
 * callback alone; the processor returns only the result — returning the
 * annotations as well would recreate the post-run batch that N2 showed
 * discards completed work wholesale.
 */
export async function processReferenceJob(
  content: string,
  inferenceClient: InferenceClient,
  params: DetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
  /**
   * The CHECKPOINT, fired once per unit after every one of its chunks has
   * committed. It carries no annotations — the effect already happened per
   * chunk through `onChunkComplete`, and a unit callback that also carried
   * them would be a second commit path.
   */
  onUnitComplete: (entityType: string) => Promise<void>,
  signal?: AbortSignal,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete?: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each entity-type unit (CHUNK-GRAIN-RESUME P3).
   * A unit absent here starts at the top; units already COMPLETE never reach
   * this function at all, the caller having filtered them out. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<{ result: JobReferenceAnnotationResult }> {
  const entityTypeNames = params.entityTypes.map(String);
  const requestParams = [{ label: 'entity-types' as const, value: entityTypeNames.join(', ') }];
  const completedItems: CompletedItem[] = [];
  // Seeded with what earlier attempts already counted for the units this
  // attempt is RESUMING. Units that completed earlier carry no cursor — they
  // are filtered out before this function sees them — so their share is still
  // missing from the job total. That is the pre-existing unit-grain gap, named
  // in CHUNK-GRAIN-RESUME rather than silently half-fixed here.
  let totalFound = Object.values(resumeCursors ?? {}).reduce((n, c) => n + c.found, 0);
  let totalEmitted = Object.values(resumeCursors ?? {}).reduce((n, c) => n + c.emitted, 0);
  let errors = 0;
  let totalUnderReportedPieces = 0;
  // The denominator: cumulative count-verifier expectations over accepted
  // pieces. Zero means no piece was priced — the frame then carries nothing.
  let totalExpected = 0;

  onProgress(10, { code: 'loading' }, { requestParams });

  const bodyLanguage = params.language ?? 'en';

  // Entity types run BOUNDED-CONCURRENT (DETECTION-QUALITY-THROUGHPUT P6).
  // They are independent units — own extraction, own commit, own checkpoint —
  // and a single sequential job used a sliver of the provider's rate limit, so
  // the old `for … await` was the 9×-sequential ≈ 2.5 h/document. The bound is
  // the point: unbounded fan-out just trades sequential waiting for 429 thrash.
  //
  // Shared counters and `completedItems` are mutated SYNCHRONOUSLY between
  // awaits inside the worker — safe under the single-threaded event loop (no
  // read-modify-write straddles an await), so no locking is needed. Progress is
  // now "M of N done" rather than "on type i": concurrent types finish out of
  // order, and `completedItems` already tolerates that.
  let completed = 0;
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
  // API parallelizes, a local single-model server does not (P6). Reading it
  // from the client is what makes the same code correct on both.
  await runBounded(entityTypeNames, inferenceClient.maxConcurrency, async (entityTypeName) => {
    if (!entityTypeName) return;
    // Cooperative cancellation (JOB-RESTART-SAFETY P4): once aborted, a pending
    // type is skipped when its turn comes; types already in flight finish and
    // commit, so committed units stay checkpointed. The caller reads
    // `signal.aborted` to move the job to cancelled/ rather than complete/.
    if (signal?.aborted) return;

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
    // What remains unknown at the unit's end: floor-accepted pieces, folded.
    let underReported: { pieces: number; found: number; counted: number } | undefined;
    await extractEntities(
      content, [entityTypeName], inferenceClient, params.includeDescriptiveReferences ?? false, logger,
      params.sourceLanguage,
      // Liveness heartbeat (DETECTION-HEARTBEAT): fires at chunk boundaries and
      // every ~15 s while a call is in flight, so a long single-chunk call is
      // not silent. It repeats the current position rather than inventing an
      // advance — the stall watchdog, janitor and client timeout need a signal,
      // not a monotone.
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
      async (chunkEntities, cursor) => {
        const built: Annotation[] = [];
        for (const entity of chunkEntities) {
          const reconciled = reconcileSelector(content, {
            exact: entity.exact,
            ...(entity.prefix !== undefined ? { prefix: entity.prefix } : {}),
            ...(entity.suffix !== undefined ? { suffix: entity.suffix } : {}),
          });
          if (!reconciled) {
            logger.error('Entity dropped — text not found in source', {
              text: entity.exact,
              entityType: entity.entityType,
            });
            errors++;
            continue;
          }
          noteAnchor('reference', entity.exact, reconciled.anchorMethod, logger);
          built.push(buildAnnotation('linking', toMatch(reconciled), unresolvedBody));
        }
        const fresh = dedupe(built);
        // What this chunk makes true ONCE IT IS DURABLE. Computed before the
        // commit because the checkpoint is written inside it and has to carry
        // the running totals — a checkpoint reporting only this attempt's share
        // would reset the count on every death — but assigned after, so the
        // invariant below still holds.
        const nextFound = unitFound + chunkEntities.length;
        const nextEmitted = unitPersisted + fresh.length;
        // Awaited: a failed commit fails the unit before it can checkpoint;
        // the cursor rides with it so the checkpoint trails the log by
        // construction rather than by the caller remembering to order them.
        await onChunkComplete?.(fresh, {
          unit: entityTypeName,
          cursor: { ...cursor, found: nextFound, emitted: nextEmitted },
        });
        // Tallies move only PAST the awaited commit — a chunk that fails to
        // commit contributes nothing anywhere — and the numerator advances at
        // the same grain as the denominator: per chunk, in the same frame
        // family the viewer's found-of-~expected tally reads.
        unitFound = nextFound;
        unitPersisted = nextEmitted;
        totalFound += chunkEntities.length;
        totalEmitted += fresh.length;
        emitTypeProgress(entityTypeName);
      },
    );

    // Every chunk of this unit is durable; only now may it checkpoint.
    await onUnitComplete(entityTypeName);
    // Found vs persisted, per unit — the gap between them is this flow's yield.
    completedItems.push({
      value: entityTypeName,
      foundCount: unitFound,
      persistedCount: unitPersisted,
      ...(underReported ? { underReported } : {}),
    });
    if (underReported) totalUnderReportedPieces += underReported.pieces;
    completed++;
    emitTypeProgress(entityTypeName);
  });

  // The terminal frame carries the completed set, and it is the only frame
  // that can: the per-unit entries ride the progress emitted at the START of
  // each unit, so the LAST unit's entry — and on a single-type job, every
  // entry — was never reported anywhere (DETECTION-QUALITY-THROUGHPUT P1).
  onProgress(100, { code: 'complete-created', count: totalEmitted, kind: 'reference' }, {
    ...(totalExpected > 0 ? { entitiesExpected: totalExpected } : {}),
    completedItems: [...completedItems],
    requestParams,
  });

  return {
    result: {
      kind: 'reference-annotation', totalFound, totalEmitted, errors,
      ...(totalUnderReportedPieces > 0 ? { underReportedPieces: totalUnderReportedPieces } : {}),
    },
  };
}

export async function processTagJob(
  content: string,
  inferenceClient: InferenceClient,
  params: TagDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  /** This chunk's novel annotations, awaited: the durability write. */
  onChunkComplete: (annotations: Annotation[], checkpoint: UnitCheckpoint) => Promise<void>,
  /** Where earlier attempts left each CATEGORY (CHUNK-GRAIN-RESUME P3) — a tag
   * job's units are its categories, not its motivation: each walks the whole
   * document, so one shared cursor would skip text for all but one of them. */
  resumeCursors?: Record<string, UnitCursor>,
): Promise<ProcessorResult<JobTagAnnotationResult>> {
  onProgress(10, { code: 'loading' });
  onProgress(30, { code: 'analyzing-tags' });

  const bodyLanguage = params.language ?? 'en';
  // One deduper across every category: they share an emission stream, and
  // the key includes the body, so only true repeats collapse.
  const dedupe = makeSpanDeduper();
  // Resumed tallies (CHUNK-GRAIN-RESUME HD3), and the two are seeded
  // DIFFERENTLY because they accumulate differently. `found` sums each
  // category's own running total at the end of that category, and those totals
  // are already seeded — seeding here too would count the earlier attempt
  // twice. `created` accumulates per chunk from this attempt only, so it must
  // start at what earlier attempts committed.
  let found = 0;
  let created = Object.values(resumeCursors ?? {}).reduce((n, c) => n + c.emitted, 0);
  // byCategory counts the DEDUPED set so the per-category counts match what
  // is actually stored. The category is the first (tagging) TextualBody.
  const byCategory: Record<string, number> = {};
  const completedItems: CompletedItem[] = [];

  for (let c = 0; c < params.categories.length; c++) {
    const category = params.categories[c]!;
    // The loop always existed; it just never reported itself, so the tag flow
    // was the one counting flow with no subject line (CLEAN-PROGRESS A5).
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
    await AnnotationDetection.detectTags(
      content, inferenceClient, params.schema, category, params.sourceLanguage,
      // Liveness (chunk boundaries + in-flight heartbeat): this category's
      // slice of the 30–60 band.
      (consumedChars, totalChars) => onProgress(
        30 + Math.round(((c + consumedChars / totalChars) / params.categories.length) * 30),
        { code: 'analyzing-tags' },
        position(),
      ),
      resumeCursors?.[category],
      async (matches, cursor) => {
        categoryFound += matches.length;
        const fresh = dedupe(matches.map((t) => {
          const cat = t.category ?? 'unknown';
          // Two-body shape matches the pre-#651 TagAnnotationWorker and every
          // persisted tag annotation: the category as a tagging TextualBody,
          // plus the tagging-schema id as a classifying TextualBody. The
          // classifying body is the only trace of schema provenance in the
          // event log — do not drop it.
          return buildAnnotation('tagging', t, [
            { type: 'TextualBody', value: cat,              purpose: 'tagging',     format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
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
        // The unit is the CATEGORY, not the motivation. `tag-annotation` loops
        // over `params.categories`, each walking the whole document from zero,
        // so a single 'tagging' key would have every category overwriting one
        // cursor — and the monotone merge would keep the furthest, which is the
        // right answer for at most one of them and silently skips text for the
        // rest. Same shape as reference's entity types, for the same reason.
        categoryCreated += fresh.length;
        await onChunkComplete(fresh, {
          unit: category,
          cursor: { ...cursor, found: categoryFound, emitted: categoryCreated },
        });
      },
    );
    found += categoryFound;
    completedItems.push({ value: category, foundCount: categoryFound });
  }

  onProgress(100, { code: 'complete-created', count: created, kind: 'tag' });

  return {
    result: { kind: 'tag-annotation', tagsFound: found, tagsCreated: created, byCategory },
  };
}

/**
 * Output bound (PDF-GENERATION P5), symmetric with #1124's extraction budget
 * and deliberately the SAME threshold: an artifact larger than what extraction
 * accepts would be a resource our own Smelter declines as 'too-large'. One
 * judgment, two enforcement points. A runaway generation fails loudly
 * (job:fail); it never uploads.
 */
export function assertWithinOutputBudget(byteLength: number): void {
  if (!withinByteBudget(byteLength)) {
    throw new Error(
      `Generated artifact exceeds the output byte budget: ${byteLength} bytes > ${MAX_PDF_BYTES}. Refusing a runaway generation.`,
    );
  }
}

export async function processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationJobParams,
  onProgress: OnProgress,
  logger: Logger,
): Promise<{ content: Uint8Array; title: string; format: SupportedMediaType; citations: GenerationCitation[]; result: GenerationResult }> {
  // Refuse any requested media type the registry doesn't mark `generatable` —
  // loudly (the throw propagates as job:fail), never a silent markdown fallback
  // under a mislabeled format. The gate reads the registry capability
  // (PDF-GENERATION P1), not a local table. Validate before the LLM call.
  const outputMediaType: SupportedMediaType = params.outputMediaType ?? 'text/markdown';
  if (!GENERATABLE_MEDIA_TYPES.includes(outputMediaType)) {
    throw new Error(
      `Unsupported outputMediaType for generation: ${outputMediaType}. Generation produces ${GENERATABLE_MEDIA_TYPES.join(' or ')}.`,
    );
  }

  const title = params.title ?? 'Untitled';
  const entityTypes = (params.entityTypes ?? []).map(String);

  // PDF path (PDF-GENERATION P3): the model authors Typst; the worker's pinned
  // binary compiles it, with the legible compile errors fed back for a bounded
  // number of repairs. Citations on PDFs need page geometry, not text offsets —
  // until the citation branch (P4) provides it, `cite` fails fast and loudly
  // rather than minting selectors that would render nothing.
  if (outputMediaType === 'application/pdf') {
    onProgress(5, { code: 'generating-resource' });

    // Under `cite`, [[<id>]] tokens are stripped from the SOURCE before every
    // compile — they must never render into the artifact. The citations carry
    // the claim text; the worker re-anchors it by page geometry after
    // extraction (P4). Offsets in these citations index the Typst source and
    // are NOT used for PDF anchoring.
    const validIds = params.cite === true ? collectContextResourceIds(params.context) : null;

    let generated = await generateResourceFromTopic(
      title, entityTypes, inferenceClient, logger,
      params.prompt, params.language, params.context, params.temperature,
      params.maxTokens, params.sourceLanguage, outputMediaType,
      params.task, params.structure, params.cite,
    );
    let source = generated.content;
    let citations: GenerationCitation[] = [];
    if (validIds) {
      const resolved = resolveCitationTokens(generated.content, validIds, logger);
      source = resolved.content;
      citations = resolved.citations;
    }
    let compiled = compileTypst(source);
    let repairs = 0;
    while ('error' in compiled) {
      // A truncated source that fails to compile is cut off, not wrong —
      // every repair regenerates under the same ceiling and cannot restore
      // content that was never generated. Fail immediately with the actual
      // cause instead of burning the repair budget and blaming the compiler
      // (GENERATE-FROM-RESOURCE P3a).
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
      if (validIds) {
        const resolved = resolveCitationTokens(generated.content, validIds, logger);
        source = resolved.content;
        citations = resolved.citations;
      } else {
        source = generated.content;
      }
      compiled = compileTypst(source);
    }

    assertWithinOutputBudget(compiled.pdf.byteLength);
    onProgress(95, { code: 'creating-resource' });
    // The producer owns terminality (GENERATE-FROM-RESOURCE P1/D1): without
    // this, the client's last frame is forever the 95% payload. Generic by
    // design — the outcome (name + link) travels on job:complete (D8).
    // `truncated` rides both surfaces (P3a/D6): truncation that lands at a
    // syntactic boundary still compiles, and the artifact is still cut off.
    onProgress(100, { code: 'complete-generated', truncated: generated.truncated });

    return {
      content: compiled.pdf,
      title,
      format: outputMediaType,
      citations,
      result: {
        kind: 'generation',
        resourceId: '' as ResourceId,
        resourceName: title,
        truncated: generated.truncated,
      },
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

  // Under `cite`, the model emitted [[<id>]] transport tokens — resolve them:
  // validate against the ids the context actually contained, strip from the
  // stored content, and carry claim-span citations for the worker to mint.
  // When cite is off, bracketed text is legitimate content — leave it alone.
  let content = generated.content;
  let citations: GenerationCitation[] = [];
  if (params.cite === true) {
    const resolved = resolveCitationTokens(content, collectContextResourceIds(params.context), logger);
    content = resolved.content;
    citations = resolved.citations;
  }

  onProgress(95, { code: 'creating-resource' });

  // The artifact is bytes; text is an encoding of them. One shape for every
  // output media type, so a string can never travel mislabeled as a binary
  // format (PDF-GENERATION P1). Citation offsets index the decoded text.
  const artifact = new TextEncoder().encode(content);
  assertWithinOutputBudget(artifact.byteLength);

  // The producer owns terminality (GENERATE-FROM-RESOURCE P1/D1): without
  // this, the client's last frame is forever the 95% payload. Generic by
  // design — the outcome (name + link) travels on job:complete (D8).
  // `truncated` rides both surfaces (P3a/D6): the event is the frame the
  // client renders, the result is the record.
  onProgress(100, { code: 'complete-generated', truncated: generated.truncated });

  return {
    content: artifact,
    title,
    format: outputMediaType,
    citations,
    result: {
      kind: 'generation',
      resourceId: '' as ResourceId,
      resourceName: title,
      truncated: generated.truncated,
    },
  };
}
