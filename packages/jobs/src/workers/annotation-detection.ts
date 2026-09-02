/**
 * Annotation Detection
 *
 * Orchestrates the full annotation detection pipeline:
 * 1. Build AI prompts using MotivationPrompts
 * 2. Call AI inference
 * 3. Parse and validate results using MotivationParsers
 *
 * All methods take content as a string parameter — the worker process
 * fetches it and hands it in.
 */

import type { ElementSchema, InferenceClient } from '@semiont/inference';
import { chunkText, estimateTokens } from '@semiont/core';
import { boundedGenerateStructured } from './inference-call';
import { DeterministicJobError } from '../failure-class';
import { deriveDetectionBudget } from './detection/detection-chunking';
import { MotivationPrompts } from './detection/motivation-prompts';
import {
  MotivationParsers,
  COMMENT_ELEMENT_SCHEMA,
  HIGHLIGHT_ELEMENT_SCHEMA,
  ASSESSMENT_ELEMENT_SCHEMA,
  TAG_ELEMENT_SCHEMA,
  type CommentMatch,
  type HighlightMatch,
  type AssessmentMatch,
  type TagMatch,
} from './detection/motivation-parsers';
import type { TagSchema } from '@semiont/core';

/**
 * A `max_tokens` stop reason means the model's JSON was cut off mid-stream.
 * Post-tool-use that still yields a syntactically-valid but incomplete array
 * (structured output serializes whatever was generated), so it would parse
 * cleanly and silently under-report. Fail the job loudly instead — parity
 * with the entity-extractor path. With derived budgets this fires only on
 * pathological annotation density.
 */
function assertNotTruncated(response: { stopReason: string }, motivation: string, chunk: number, totalChunks: number, outputBudget: number): void {
  if (response.stopReason === 'max_tokens') {
    // Same input truncates the same way — a retry is guaranteed waste, so
    // this is a DeterministicJobError (ABANDONED-INFERENCE P3, A4).
    throw new DeterministicJobError(`${motivation} detection response truncated (max_tokens) on chunk ${chunk}/${totalChunks} despite the derived output budget of ${outputBudget} tokens — failing the job rather than under-reporting annotations.`);
  }
}

/**
 * Per-chunk detection loop shared by the four motivations.
 *
 * Budgets derive from the provider's actual limits plus the measured prompt
 * scaffold (`buildPrompt('')`) — no literals. The prompt receives one chunk;
 * `parse` reconciles against the FULL document (the callers close over it),
 * so offsets index into the whole resource with no re-anchoring arithmetic.
 * Overlap duplicates pass through — the processor's span-keyed
 * `dedupeAnnotations` is the single dedupe point.
 *
 * `onActivity` fires whenever the detection is demonstrably alive: at each
 * chunk boundary (the count advances) AND periodically while one inference
 * call is in flight (the count repeats — liveness, not progress). Progress is
 * the worker's liveness heartbeat AND the client's inter-emission timeout
 * signal, so a silent single-chunk run kills a healthy job
 * (DETECTION-HEARTBEAT).
 */
async function detectInChunks<T>(
  client: InferenceClient,
  content: string,
  buildPrompt: (chunk: string) => string,
  temperature: number,
  motivation: string,
  elementSchema: ElementSchema,
  parse: (items: unknown[]) => T[],
  onActivity?: (completedChunks: number, totalChunks: number) => void,
): Promise<T[]> {
  const limits = await client.limits();
  const scaffoldTokens = estimateTokens(buildPrompt(''));
  const { chunking, outputBudget } = deriveDetectionBudget(limits, scaffoldTokens);
  const chunks = chunkText(content, chunking);

  const collected: T[] = [];
  for (let i = 0; i < chunks.length; i++) {
    // Structured surface: parsed elements or a throw — an unreadable model
    // response fails the job rather than reading as an empty detection.
    const response = await boundedGenerateStructured<unknown>(
      client, buildPrompt(chunks[i]!), outputBudget, temperature, elementSchema,
      // Still alive, same position (a long single call is otherwise silent).
      () => onActivity?.(i, chunks.length),
    );
    assertNotTruncated(response, motivation, i + 1, chunks.length, outputBudget);
    collected.push(...parse(response.items));
    if (i < chunks.length - 1) {
      onActivity?.(i + 1, chunks.length);
    }
  }
  return collected;
}

export class AnnotationDetection {

  /**
   * Detect comments in content.
   *
   * `language` is the locale the LLM should write comment text in (annotation
   * body locale). `sourceLanguage` is the locale of the content being analyzed
   * (source-resource locale). See `types.ts` "Locale conventions" for the
   * full discussion.
   */
  static async detectComments(
    content: string,
    client: InferenceClient,
    instructions?: string,
    tone?: string,
    density?: number,
    language?: string,
    sourceLanguage?: string,
    onActivity?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<CommentMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildCommentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      0.4, 'comment', COMMENT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseComments(items, content),
      onActivity,
    );
  }

  /**
   * Detect highlights in content.
   *
   * Highlights have no body — only `sourceLanguage` (source-resource locale)
   * applies, used in the prompt so the LLM analyzes non-English source
   * correctly.
   */
  static async detectHighlights(
    content: string,
    client: InferenceClient,
    instructions?: string,
    density?: number,
    sourceLanguage?: string,
    onActivity?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<HighlightMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildHighlightPrompt(chunk, instructions, density, sourceLanguage),
      0.3, 'highlight', HIGHLIGHT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseHighlights(items, content),
      onActivity,
    );
  }

  /**
   * Detect assessments in content.
   *
   * `language` is the locale the LLM should write assessment text in
   * (annotation body locale). `sourceLanguage` is the locale of the content
   * being analyzed (source-resource locale).
   */
  static async detectAssessments(
    content: string,
    client: InferenceClient,
    instructions?: string,
    tone?: string,
    density?: number,
    language?: string,
    sourceLanguage?: string,
    onActivity?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<AssessmentMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildAssessmentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      0.3, 'assessment', ASSESSMENT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseAssessments(items, content),
      onActivity,
    );
  }

  /**
   * Detect tags in content for a specific category.
   *
   * The full `TagSchema` is supplied by the dispatcher (resolved against
   * the per-KB tag-schema projection at job-creation time) so the worker
   * is independent of the registry.
   *
   * `sourceLanguage` is the locale of the content being analyzed. Body-locale
   * (`language`) doesn't influence the tag prompt — categories are schema
   * identifiers, not LLM-generated text — so it's consumed at the body-stamp
   * site, not here.
   */
  static async detectTags(
    content: string,
    client: InferenceClient,
    schema: TagSchema,
    category: string,
    sourceLanguage?: string,
    onActivity?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<TagMatch[]> {
    const categoryInfo = schema.tags.find((t) => t.name === category);
    if (!categoryInfo) {
      throw new Error(`Invalid category "${category}" for schema ${schema.id}`);
    }

    // Parse per chunk; anchor once against the full document afterward.
    const parsedTags = await detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildTagPrompt(
        chunk,
        category,
        schema.name,
        schema.description,
        schema.domain,
        categoryInfo.description,
        categoryInfo.examples,
        sourceLanguage
      ),
      0.2, 'tag', TAG_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseTags(items),
      onActivity,
    );
    return MotivationParsers.validateTagOffsets(parsedTags, content, category);
  }
}
