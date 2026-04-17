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
import { userToAgent, type ResourceId, type components } from '@semiont/core';
import { validateAndCorrectOffsets } from '@semiont/api-client';
import type { InferenceClient } from '@semiont/inference';
import type {
  JobMetadata,
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

export type OnProgress = (percentage: number, message: string, stage: string) => void;

export interface ProcessorResult<R> {
  annotations: Record<string, unknown>[];
  result: R;
}

function buildCreator(metadata: JobMetadata) {
  return userToAgent({
    id: metadata.userId,
    name: metadata.userName,
    email: metadata.userEmail,
    domain: metadata.userDomain,
  });
}

function buildTextAnnotation(
  resourceId: ResourceId,
  metadata: JobMetadata,
  generator: Agent,
  motivation: string,
  match: { exact: string; start: number; end: number; prefix?: string; suffix?: string },
  body: Record<string, unknown>[],
) {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
    'type': 'Annotation' as const,
    'id': generateAnnotationId(),
    motivation,
    creator: buildCreator(metadata),
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
  metadata: JobMetadata,
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
    buildTextAnnotation(params.resourceId, metadata, generator, 'highlighting', h, []),
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
  metadata: JobMetadata,
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
    buildTextAnnotation(params.resourceId, metadata, generator, 'commenting', c, [
      { type: 'TextualBody', value: c.comment, purpose: 'commenting' },
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
  metadata: JobMetadata,
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
    buildTextAnnotation(params.resourceId, metadata, generator, 'assessing', a, [
      { type: 'TextualBody', value: a.assessment, purpose: 'describing' },
    ]),
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
  metadata: JobMetadata,
  generator: Agent,
  onProgress: OnProgress,
  logger?: import('@semiont/core').Logger,
): Promise<ProcessorResult<DetectionResult>> {
  onProgress(10, 'Loading resource...', 'analyzing');

  const entityTypeNames = params.entityTypes.map(String);
  let totalFound = 0;
  let totalEmitted = 0;
  let errors = 0;
  const allAnnotations: Record<string, unknown>[] = [];

  for (let i = 0; i < entityTypeNames.length; i++) {
    const entityTypeName = entityTypeNames[i];
    const pct = 20 + Math.round((i / entityTypeNames.length) * 60);
    onProgress(pct, `Detecting ${entityTypeName} entities...`, 'analyzing');

    const extractedEntities = await extractEntities(
      content, [entityTypeName], inferenceClient, params.includeDescriptiveReferences ?? false, logger,
    );

    totalFound += extractedEntities.length;

    for (const entity of extractedEntities) {
      try {
        const validated = validateAndCorrectOffsets(content, entity.startOffset, entity.endOffset, entity.exact);
        const ann = buildTextAnnotation(params.resourceId, metadata, generator, 'linking', validated, []);
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
  metadata: JobMetadata,
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
    return buildTextAnnotation(params.resourceId, metadata, generator, 'tagging', t, [
      { type: 'TextualBody', value: category, purpose: 'tagging' },
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
