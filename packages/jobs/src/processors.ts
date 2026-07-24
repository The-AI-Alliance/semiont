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
import { resolveCitationTokens, collectContextResourceIds, type GenerationCitation } from './workers/generation/citation-resolver';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { didToAgent, type Logger, type ResourceId, type SupportedMediaType, type components } from '@semiont/core';
import { reconcileSelector, createFragmentSelector, type ReconciledSelector } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import { locate, type PdfTextLayer } from '@semiont/content';
import type {
  HighlightDetectionParams,
  CommentDetectionParams,
  AssessmentDetectionParams,
  DetectionParams,
  TagDetectionParams,
  GenerationParams,
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
  motivation: string,
  match: SpanMatch,
  body?: Record<string, unknown> | Record<string, unknown>[],
) => Record<string, unknown>;

/**
 * Progress callback. The three positional args satisfy the minimum
 * `JobProgress` required fields (`percentage`, `message`, `stage`).
 * The fourth optional arg carries job-type-specific fields
 * (`currentEntityType`, `completedEntityTypes`, `requestParams`, etc.)
 * that the progress UI renders.
 */
export type OnProgress = (
  percentage: number,
  message: string,
  stage: string,
  extra?: Partial<JobProgress>,
) => void;

type JobProgress = components['schemas']['JobProgress'];

export interface ProcessorResult<R> {
  annotations: Record<string, unknown>[];
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
  const target = ann.target as { selector?: Array<{ type: string; start?: number; end?: number }> } | undefined;
  const selectors = Array.isArray(target?.selector) ? target.selector : [];
  const pos = selectors.find((s) => s.type === 'TextPositionSelector');
  return [
    ann.motivation as string,
    pos?.start ?? '?',
    pos?.end ?? '?',
    JSON.stringify(ann.body ?? null),
  ].join('|');
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
function dedupeAnnotations(annotations: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
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
  motivation: string,
  match: { exact: string; start: number; end: number; prefix?: string; suffix?: string },
  // Body may be a single AnnotationBody object or a non-empty array of
  // them, OR omitted entirely. W3C treats body as optional; annotations
  // whose motivation alone conveys meaning (highlighting) legitimately
  // skip it. Every other motivation currently passes something; the
  // processor that calls this makes the choice per-motivation.
  body?: Record<string, unknown> | Record<string, unknown>[],
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
  layer: PdfTextLayer,
  resourceId: ResourceId,
  userId: string,
  generator: Agent,
  motivation: string,
  match: { exact: string; start: number; end: number; prefix?: string; suffix?: string },
  body?: Record<string, unknown> | Record<string, unknown>[],
) {
  const rects = locate(layer, match.start, match.end);

  const covered = layer.items.filter((i) => i.start < match.end && i.end > match.start);
  const coveredText = covered.length
    ? layer.text.substring(
        Math.min(...covered.map((i) => i.start)),
        Math.max(...covered.map((i) => i.end)),
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
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text...', 'analyzing');

  const highlights = await AnnotationDetection.detectHighlights(
    content, inferenceClient, params.instructions, params.density, params.sourceLanguage,
  );

  onProgress(60, `Creating ${highlights.length} annotations...`, 'creating');

  // Highlights carry no body — motivation:'highlighting' on a target
  // is a complete annotation per the W3C Web Annotation Model.
  const annotations = dedupeAnnotations(highlights.map((h) =>
    buildAnnotation('highlighting', h),
  ));

  onProgress(100, `Complete! Created ${annotations.length} highlights`, 'creating');

  return {
    annotations,
    result: { highlightsFound: highlights.length, highlightsCreated: annotations.length },
  };
}

export async function processCommentJob(
  content: string,
  inferenceClient: InferenceClient,
  params: CommentDetectionParams,
  buildAnnotation: BuildAnnotation,
  onProgress: OnProgress,
): Promise<ProcessorResult<CommentDetectionResult>> {
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text...', 'analyzing');

  const comments = await AnnotationDetection.detectComments(
    content, inferenceClient, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
  );

  onProgress(60, `Creating ${comments.length} annotations...`, 'creating');

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

  onProgress(100, `Complete! Created ${annotations.length} comments`, 'creating');

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
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text...', 'analyzing');

  const assessments = await AnnotationDetection.detectAssessments(
    content, inferenceClient, params.instructions, params.tone, params.density,
    params.language, params.sourceLanguage,
  );

  onProgress(60, `Creating ${assessments.length} annotations...`, 'creating');

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

  onProgress(100, `Complete! Created ${annotations.length} assessments`, 'creating');

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
  const requestParams = [{ label: 'Entity types', value: entityTypeNames.join(', ') }];
  const completedEntityTypes: Array<{ entityType: string; foundCount: number }> = [];
  let totalFound = 0;
  let totalEmitted = 0;
  let errors = 0;
  const allAnnotations: Record<string, unknown>[] = [];

  onProgress(10, 'Loading resource...', 'analyzing', { requestParams });

  const bodyLanguage = params.language ?? 'en';

  for (let i = 0; i < entityTypeNames.length; i++) {
    const entityTypeName = entityTypeNames[i];
    if (!entityTypeName) continue;
    const pct = 20 + Math.round((i / entityTypeNames.length) * 60);
    onProgress(pct, `Detecting ${entityTypeName} entities...`, 'analyzing', {
      currentEntityType: entityTypeName,
      processedEntityTypes: i,
      totalEntityTypes: entityTypeNames.length,
      entitiesFound: totalFound,
      entitiesEmitted: totalEmitted,
      completedEntityTypes: [...completedEntityTypes],
      requestParams,
    });

    const extractedEntities = await extractEntities(
      content, [entityTypeName], inferenceClient, params.includeDescriptiveReferences ?? false, logger,
      params.sourceLanguage,
    );

    totalFound += extractedEntities.length;
    completedEntityTypes.push({ entityType: entityTypeName, foundCount: extractedEntities.length });

    // Unresolved reference body: the entity type as a tagging TextualBody,
    // stamped with the body locale to match the comment/assess/tag pattern.
    // The bind flow later appends a SpecificResource (purpose: 'linking')
    // via mark:body-updated to produce the resolved shape. Emitting an
    // empty body would break the append contract.
    const unresolvedBody = [
      { type: 'TextualBody', value: entityTypeName, purpose: 'tagging', format: 'text/plain' satisfies SupportedMediaType, language: bodyLanguage },
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

  onProgress(100, `Complete! Created ${annotations.length} references`, 'creating');

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
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text for tags...', 'analyzing');

  const allTags = [];
  for (const category of params.categories) {
    const categoryTags = await AnnotationDetection.detectTags(
      content, inferenceClient, params.schema, category, params.sourceLanguage,
    );
    allTags.push(...categoryTags);
  }
  const tags = allTags;

  onProgress(60, `Creating ${tags.length} tag annotations...`, 'creating');

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

  onProgress(100, `Complete! Created ${annotations.length} tags`, 'creating');

  return {
    annotations,
    result: { tagsFound: tags.length, tagsCreated: annotations.length, byCategory },
  };
}

export async function processGenerationJob(
  inferenceClient: InferenceClient,
  params: GenerationParams,
  onProgress: OnProgress,
  logger: Logger,
): Promise<{ content: string; title: string; format: SupportedMediaType; citations: GenerationCitation[]; result: GenerationResult }> {
  // Generation produces text only for now. Refuse any other requested media type
  // loudly (the throw propagates as job:fail) rather than silently emitting markdown
  // under a mislabeled format. Validate before the LLM call so it fails fast.
  const GENERATABLE_MEDIA_TYPES: readonly SupportedMediaType[] = ['text/markdown', 'text/plain'];
  const outputMediaType: SupportedMediaType = params.outputMediaType ?? 'text/markdown';
  if (!GENERATABLE_MEDIA_TYPES.includes(outputMediaType)) {
    throw new Error(
      `Unsupported outputMediaType for generation: ${outputMediaType}. Generation produces ${GENERATABLE_MEDIA_TYPES.join(' or ')}.`,
    );
  }

  const title = params.title ?? 'Untitled';
  const entityTypes = (params.entityTypes ?? []).map(String);

  // Generation has exactly two observable transitions: the LLM call starting
  // ('generating') and content finalized / creation beginning ('creating').
  // There is no fetch — context arrives pre-gathered in params. Percentages
  // approximate the share of expected wall-clock complete at each transition
  // (a single atomic LLM call has no measurable progress, and inference
  // dominates the job): its start is ~5, its end ~95.
  onProgress(5, 'Generating resource...', 'generating');

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

  onProgress(95, 'Creating resource...', 'creating');

  return {
    content,
    title: generated.title ?? title,
    format: outputMediaType,
    citations,
    result: {
      resourceId: '' as ResourceId,
      resourceName: generated.title ?? title,
    },
  };
}
