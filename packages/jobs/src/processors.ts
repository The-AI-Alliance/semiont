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
import { generateResourceFromTopic } from './workers/generation/resource-generation';
import { compileTypst, MAX_COMPILE_REPAIRS } from './workers/generation/typst-compiler';
import { withinByteBudget, MAX_PDF_BYTES } from '@semiont/content';
import { resolveCitationTokens, collectContextResourceIds, type GenerationCitation } from './workers/generation/citation-resolver';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { didToAgent, GENERATABLE_MEDIA_TYPES, type Annotation, type GenerationJobParams, type Logger, type ResourceId, type SupportedMediaType, type components } from '@semiont/core';
import { reconcileSelector, createFragmentSelector, locate, type ReconciledSelector, type AnchoredText } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type {
  HighlightDetectionParams,
  CommentDetectionParams,
  AssessmentDetectionParams,
  DetectionParams,
  TagDetectionParams,
  HighlightDetectionResult,
  CommentDetectionResult,
  AssessmentDetectionResult,
  DetectionResult,
  TagDetectionResult,
  GenerationResult,
} from './types';

type Agent = components['schemas']['Agent'];

/** A detected span — offsets into the extracted `.text`, plus optional context. */
export type SpanMatch = { exact: string; start: number; end: number; prefix?: string; suffix?: string };

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
type JobProgressMessage = components['schemas']['JobProgressMessage'];

/** The five W3C motivations this system mints — a closed vocabulary, so it is
 *  typed as one rather than as `string`. */
export type Motivation = Annotation['motivation'];

export interface ProcessorResult<R> {
  annotations: Annotation[];
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
function dedupeAnnotations(annotations: Annotation[]): Annotation[] {
  const seen = new Set<string>();
  const out: Annotation[] = [];
  for (const ann of annotations) {
    const key = annotationDedupeKey(ann);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ann);
  }
  return out;
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
    'id': generateAnnotationId(),
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
  if (rects.length === 0 || !normalize(coveredText).includes(normalize(match.exact))) {
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
    'id': generateAnnotationId(),
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

export async function processHighlightJob(
  content: string,
  inferenceClient: InferenceClient,
  params: HighlightDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
): Promise<ProcessorResult<HighlightDetectionResult>> {
  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  const highlights = await AnnotationDetection.detectHighlights(
    content, inferenceClient, params.instructions, params.density, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band.
    (completed, total) => onProgress(30 + Math.round((completed / total) * 30), { code: 'analyzing' }, echo),
  );

  onProgress(60, { code: 'creating-annotations', count: highlights.length }, echo);

  // Highlights carry no body — motivation:'highlighting' on a target
  // is a complete annotation per the W3C Web Annotation Model.
  const annotations = dedupeAnnotations(highlights.map((h) =>
    buildAnnotation('highlighting', h),
  ));

  onProgress(100, { code: 'complete-created', count: annotations.length, kind: 'highlight' }, echo);

  return {
    annotations,
    result: { highlightsFound: highlights.length, highlightsCreated: annotations.length },
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
): Promise<ProcessorResult<CommentDetectionResult>> {
  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  const comments = await AnnotationDetection.detectComments(
    content, inferenceClient, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band.
    (completed, total) => onProgress(30 + Math.round((completed / total) * 30), { code: 'analyzing' }, echo),
  );

  onProgress(60, { code: 'creating-annotations', count: comments.length }, echo);

  // The body's `language` reflects the locale the LLM was asked to write in
  // (`params.language` — the user's UI locale). Defaults to 'en' when the
  // caller didn't specify, matching what the LLM produces by default.
  const bodyLanguage = params.language ?? 'en';
  const annotations = dedupeAnnotations(comments.map((c) =>
    // Match the pre-#651 CommentAnnotationWorker: include format and
    // language on the body TextualBody. Optional in the schema, but
    // consumers that do language-aware rendering rely on them.
    buildAnnotation('commenting', c, [
      { type: 'TextualBody', value: c.comment, purpose: 'commenting', format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
    ]),
  ));

  onProgress(100, { code: 'complete-created', count: annotations.length, kind: 'comment' }, echo);

  return {
    annotations,
    result: { commentsFound: comments.length, commentsCreated: annotations.length },
  };
}

export async function processAssessmentJob(
  content: string,
  inferenceClient: InferenceClient,
  params: AssessmentDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
): Promise<ProcessorResult<AssessmentDetectionResult>> {
  const echo = detectionEcho(params);

  onProgress(10, { code: 'loading' }, echo);
  onProgress(30, { code: 'analyzing' }, echo);

  const assessments = await AnnotationDetection.detectAssessments(
    content, inferenceClient, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
    // Liveness (chunk boundaries + in-flight heartbeat): 30–60 band.
    (completed, total) => onProgress(30 + Math.round((completed / total) * 30), { code: 'analyzing' }, echo),
  );

  onProgress(60, { code: 'creating-annotations', count: assessments.length }, echo);

  const bodyLanguage = params.language ?? 'en';
  const annotations = dedupeAnnotations(assessments.map((a) =>
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

  onProgress(100, { code: 'complete-created', count: annotations.length, kind: 'assessment' }, echo);

  return {
    annotations,
    result: { assessmentsFound: assessments.length, assessmentsCreated: annotations.length },
  };
}

export async function processReferenceJob(
  content: string,
  inferenceClient: InferenceClient,
  params: DetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
  logger: Logger,
): Promise<ProcessorResult<DetectionResult>> {
  const entityTypeNames = params.entityTypes.map(String);
  const requestParams = [{ label: 'entity-types' as const, value: entityTypeNames.join(', ') }];
  const completedItems: Array<{ value: string; foundCount: number }> = [];
  let totalFound = 0;
  let totalEmitted = 0;
  let errors = 0;
  const allAnnotations: Annotation[] = [];

  onProgress(10, { code: 'loading' }, { requestParams });

  const bodyLanguage = params.language ?? 'en';

  for (let i = 0; i < entityTypeNames.length; i++) {
    const entityTypeName = entityTypeNames[i];
    if (!entityTypeName) continue;
    const pct = 20 + Math.round((i / entityTypeNames.length) * 60);
    onProgress(pct, { code: 'detecting-entities', entityType: entityTypeName }, {
      // One vocabulary for "what is in flight" (CLEAN-PROGRESS D2): the entity
      // type is KB data, `kind` is the code the client localizes around it.
      current: { kind: 'entity-type', value: entityTypeName },
      processed: i,
      total: entityTypeNames.length,
      entitiesFound: totalFound,
      entitiesEmitted: totalEmitted,
      completedItems: [...completedItems],
      requestParams,
    });

    const extractedEntities = await extractEntities(
      content, [entityTypeName], inferenceClient, params.includeDescriptiveReferences ?? false, logger,
      params.sourceLanguage,
      // Liveness: fires at chunk boundaries AND every ~15 s while a single
      // inference call is in flight (DETECTION-HEARTBEAT). Progress feeds the
      // stall watchdog, the janitor, AND the client's inter-emission timeout,
      // so a long single-chunk call must not be silent. Percentage
      // interpolates within this entity type's band of the 20–80 range; a
      // heartbeat repeats the current position rather than inventing an
      // advance.
      (completed, total) => {
        const interpolated = 20 + Math.round(((i + completed / total) / entityTypeNames.length) * 60);
        onProgress(interpolated, { code: 'detecting-entities', entityType: entityTypeName }, {
          current: { kind: 'entity-type', value: entityTypeName },
          processed: i,
          total: entityTypeNames.length,
          entitiesFound: totalFound,
          entitiesEmitted: totalEmitted,
          completedItems: [...completedItems],
          requestParams,
        });
      },
    );

    totalFound += extractedEntities.length;
    completedItems.push({ value: entityTypeName, foundCount: extractedEntities.length });

    // Unresolved reference body: the entity type as a tagging TextualBody,
    // stamped with the body locale to match the comment/assess/tag pattern.
    // The bind flow later appends a SpecificResource (purpose: 'linking')
    // via mark:body-updated to produce the resolved shape. Emitting an
    // empty body would break the append contract.
    const unresolvedBody: Annotation['body'] = [
      { type: 'TextualBody' as const, value: entityTypeName, purpose: 'tagging' as const, format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
    ];

    for (const entity of extractedEntities) {
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
      if (reconciled.anchorMethod === 'first-of-many' || reconciled.anchorMethod === 'fuzzy-match') {
        logger.warn('Entity anchored via degraded method', {
          text: entity.exact,
          entityType: entity.entityType,
          anchorMethod: reconciled.anchorMethod,
        });
      }
      const ann = buildAnnotation('linking', toMatch(reconciled), unresolvedBody);
      allAnnotations.push(ann);
      totalEmitted++;
    }
  }

  // De-dupe identical events before reporting. `totalEmitted` was the
  // running per-push count used for mid-loop progress; the stored/reported
  // count is the deduped length — repeated entities that collapsed onto
  // the same span (same entity type) become a single annotation.
  const annotations = dedupeAnnotations(allAnnotations);

  onProgress(100, { code: 'complete-created', count: annotations.length, kind: 'reference' }, { requestParams });

  return {
    annotations,
    result: { totalFound, totalEmitted: annotations.length, errors },
  };
}

export async function processTagJob(
  content: string,
  inferenceClient: InferenceClient,
  params: TagDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
): Promise<ProcessorResult<TagDetectionResult>> {
  onProgress(10, { code: 'loading' });
  onProgress(30, { code: 'analyzing-tags' });

  const allTags = [];
  const completedItems: Array<{ value: string; foundCount: number }> = [];
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
    const categoryTags = await AnnotationDetection.detectTags(
      content, inferenceClient, params.schema, category, params.sourceLanguage,
      // Liveness (chunk boundaries + in-flight heartbeat): this category's
      // slice of the 30–60 band.
      (completed, total) => onProgress(
        30 + Math.round(((c + completed / total) / params.categories.length) * 30),
        { code: 'analyzing-tags' },
        position(),
      ),
    );
    completedItems.push({ value: category, foundCount: categoryTags.length });
    allTags.push(...categoryTags);
  }
  const tags = allTags;

  onProgress(60, { code: 'creating-tag-annotations', count: tags.length });

  const bodyLanguage = params.language ?? 'en';
  const annotations = dedupeAnnotations(tags.map((t) => {
    const category = t.category ?? 'unknown';
    // Two-body shape matches the pre-#651 TagAnnotationWorker and every
    // persisted tag annotation: the category as a tagging TextualBody,
    // plus the tagging-schema id as a classifying TextualBody. The
    // classifying body is the only trace of schema provenance in the
    // event log — do not drop it.
    return buildAnnotation('tagging', t, [
      { type: 'TextualBody', value: category,         purpose: 'tagging',     format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
      { type: 'TextualBody', value: params.schema.id, purpose: 'classifying', format: 'text/plain' satisfies SupportedMediaType },
    ]);
  }));

  // byCategory is computed from the *deduped* set so the per-category
  // counts match what's actually stored. The category is the first
  // (tagging) TextualBody's value.
  const byCategory: Record<string, number> = {};
  for (const ann of annotations) {
    const body = (ann as { body?: Array<{ value?: unknown }> }).body;
    const category = Array.isArray(body) && typeof body[0]?.value === 'string' ? body[0].value : 'unknown';
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }

  onProgress(100, { code: 'complete-created', count: annotations.length, kind: 'tag' });

  return {
    annotations,
    result: { tagsFound: tags.length, tagsCreated: annotations.length, byCategory },
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
    while ('error' in compiled && repairs < MAX_COMPILE_REPAIRS) {
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
    if ('error' in compiled) {
      throw new Error(
        `Typst compilation failed after ${MAX_COMPILE_REPAIRS} repair attempts: ${compiled.error}`,
      );
    }

    assertWithinOutputBudget(compiled.pdf.byteLength);
    onProgress(95, { code: 'creating-resource' });

    return {
      content: compiled.pdf,
      title: generated.title ?? title,
      format: outputMediaType,
      citations,
      result: {
        resourceId: '' as ResourceId,
        resourceName: generated.title ?? title,
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

  return {
    content: artifact,
    title: generated.title ?? title,
    format: outputMediaType,
    citations,
    result: {
      resourceId: '' as ResourceId,
      resourceName: generated.title ?? title,
    },
  };
}
