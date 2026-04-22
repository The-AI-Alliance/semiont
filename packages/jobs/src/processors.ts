/**
 * Job Processors — extracted from JobWorker subclasses
 *
 * Pure functions that take content + inference client + params,
 * report progress via callback, and return annotations + results.
 *
 * No EventBus, no JobQueue, no side effects except calling inference.
 * Two callers:
 *   1. In-process JobWorker subclasses (existing path)
 *   2. Remote WorkerVM via worker-process.ts (new path)
 */

import { AnnotationDetection } from './workers/annotation-detection';
import { extractEntities } from './workers/detection/entity-extractor';
import { generateResourceFromTopic } from './workers/generation/resource-generation';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { didToAgent, type ResourceId, type components } from '@semiont/core';
import { validateAndCorrectOffsets } from '@semiont/api-client';
import type { InferenceClient } from '@semiont/inference';
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

function buildTextAnnotation(
  resourceId: ResourceId,
  userId: string,
  generator: Agent,
  motivation: string,
  match: { exact: string; start: number; end: number; prefix?: string; suffix?: string },
  // Body may be a single AnnotationBody object, a non-empty array of them,
  // or an empty array (stub). Schema `Annotation.body` allows each; choice
  // is fixed per-motivation by the processor that calls this. Reader code
  // (e.g. `getCommentText`) already handles both array and object via
  // `Array.isArray(body) ? body[0] : body`.
  body: Record<string, unknown> | Record<string, unknown>[],
) {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    'type': 'Annotation' as const,
    'id': generateAnnotationId(),
    motivation,
    creator: didToAgent(userId),
    generator,
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
    body,
  };
}

export async function processHighlightJob(
  content: string,
  inferenceClient: InferenceClient,
  params: HighlightDetectionParams,
  userId: string,
  generator: Agent,
  onProgress: OnProgress,
): Promise<ProcessorResult<HighlightDetectionResult>> {
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text...', 'analyzing');

  const highlights = await AnnotationDetection.detectHighlights(
    content, inferenceClient, params.instructions, params.density,
  );

  onProgress(60, `Creating ${highlights.length} annotations...`, 'creating');

  const annotations = highlights.map((h) =>
    buildTextAnnotation(params.resourceId, userId, generator, 'highlighting', h, []),
  );

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
  userId: string,
  generator: Agent,
  onProgress: OnProgress,
): Promise<ProcessorResult<CommentDetectionResult>> {
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text...', 'analyzing');

  const comments = await AnnotationDetection.detectComments(
    content, inferenceClient, params.instructions, params.tone, params.density,
  );

  onProgress(60, `Creating ${comments.length} annotations...`, 'creating');

  const annotations = comments.map((c) =>
    // Match the pre-#651 CommentAnnotationWorker: include format and
    // language on the body TextualBody. Optional in the schema, but
    // consumers that do language-aware rendering rely on them.
    buildTextAnnotation(params.resourceId, userId, generator, 'commenting', c, [
      { type: 'TextualBody', value: c.comment, purpose: 'commenting', format: 'text/plain', language: 'en' },
    ]),
  );

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
  userId: string,
  generator: Agent,
  onProgress: OnProgress,
): Promise<ProcessorResult<AssessmentDetectionResult>> {
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text...', 'analyzing');

  const assessments = await AnnotationDetection.detectAssessments(
    content, inferenceClient, params.instructions, params.tone, params.density,
  );

  onProgress(60, `Creating ${assessments.length} annotations...`, 'creating');

  const annotations = assessments.map((a) =>
    // Single-object body with purpose aligned to motivation, matching the
    // pre-#651 AssessmentAnnotationWorker's shape and the majority of
    // persisted assessments. Do not switch to an array or to
    // purpose='describing' — that loses the "this is an assessment, not
    // a description" signal and breaks existing readers that access
    // `body.value` directly on the object.
    buildTextAnnotation(params.resourceId, userId, generator, 'assessing', a, {
      type: 'TextualBody', value: a.assessment, purpose: 'assessing', format: 'text/plain', language: 'en',
    }),
  );

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
  userId: string,
  generator: Agent,
  onProgress: OnProgress,
  logger?: import('@semiont/core').Logger,
): Promise<ProcessorResult<DetectionResult>> {
  const entityTypeNames = params.entityTypes.map(String);
  const requestParams = [{ label: 'Entity types', value: entityTypeNames.join(', ') }];
  const completedEntityTypes: Array<{ entityType: string; foundCount: number }> = [];
  let totalFound = 0;
  let totalEmitted = 0;
  let errors = 0;
  const allAnnotations: Record<string, unknown>[] = [];

  onProgress(10, 'Loading resource...', 'analyzing', { requestParams });

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
    );

    totalFound += extractedEntities.length;
    completedEntityTypes.push({ entityType: entityTypeName, foundCount: extractedEntities.length });

    // Unresolved reference body: the entity type as a tagging TextualBody.
    // The bind flow later appends a SpecificResource (purpose: 'linking')
    // via mark:body-updated to produce the resolved shape. Emitting an
    // empty body would break the append contract.
    const unresolvedBody = [{ type: 'TextualBody', value: entityTypeName, purpose: 'tagging' }];

    for (const entity of extractedEntities) {
      try {
        const validated = validateAndCorrectOffsets(content, entity.startOffset, entity.endOffset, entity.exact);
        const ann = buildTextAnnotation(
          params.resourceId, userId, generator, 'linking', validated, unresolvedBody,
        );
        allAnnotations.push(ann);
        totalEmitted++;
      } catch {
        errors++;
      }
    }
  }

  onProgress(100, `Complete! Created ${totalEmitted} references`, 'creating');

  return {
    annotations: allAnnotations,
    result: { totalFound, totalEmitted, errors },
  };
}

export async function processTagJob(
  content: string,
  inferenceClient: InferenceClient,
  params: TagDetectionParams,
  userId: string,
  generator: Agent,
  onProgress: OnProgress,
): Promise<ProcessorResult<TagDetectionResult>> {
  onProgress(10, 'Loading resource...', 'analyzing');
  onProgress(30, 'Analyzing text for tags...', 'analyzing');

  const allTags = [];
  for (const category of params.categories) {
    const categoryTags = await AnnotationDetection.detectTags(
      content, inferenceClient, params.schemaId, category,
    );
    allTags.push(...categoryTags);
  }
  const tags = allTags;

  onProgress(60, `Creating ${tags.length} tag annotations...`, 'creating');

  const byCategory: Record<string, number> = {};
  const annotations = tags.map((t) => {
    const category = t.category ?? 'unknown';
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    // Two-body shape matches the pre-#651 TagAnnotationWorker and every
    // persisted tag annotation: the category as a tagging TextualBody,
    // plus the tagging-schema id as a classifying TextualBody. The
    // classifying body is the only trace of schema provenance in the
    // event log — do not drop it.
    return buildTextAnnotation(params.resourceId, userId, generator, 'tagging', t, [
      { type: 'TextualBody', value: category,        purpose: 'tagging',     format: 'text/plain', language: 'en' },
      { type: 'TextualBody', value: params.schemaId, purpose: 'classifying', format: 'text/plain' },
    ]);
  });

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
): Promise<{ content: string; title: string; format: string; result: GenerationResult }> {
  onProgress(20, 'Fetching context...', 'fetching');

  const title = params.title ?? 'Untitled';
  const entityTypes = (params.entityTypes ?? []).map(String);

  onProgress(40, 'Generating resource...', 'generating');

  const generated = await generateResourceFromTopic(
    title,
    entityTypes,
    inferenceClient,
    params.prompt,
    params.language,
    params.context,
    params.temperature,
    params.maxTokens,
  );

  onProgress(85, 'Creating resource...', 'creating');

  return {
    content: generated.content,
    title: generated.title ?? title,
    format: 'text/markdown',
    result: {
      resourceId: '' as ResourceId,
      resourceName: generated.title ?? title,
    },
  };
}
