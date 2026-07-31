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

import type { InferenceClient, InferenceResponse } from '@semiont/inference';
import { chunkText, estimateTokens } from '@semiont/core';
import { boundedGenerateWithMetadata } from './inference-call';
import { deriveDetectionBudget } from './detection/detection-chunking';
import { MotivationPrompts } from './detection/motivation-prompts';
import {
  MotivationParsers,
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
function assertNotTruncated(response: InferenceResponse, motivation: string, chunk: number, totalChunks: number): void {
  if (response.stopReason === 'max_tokens') {
    throw new Error(`${motivation} detection response truncated (max_tokens) on chunk ${chunk}/${totalChunks} despite the derived output budget — failing the job rather than under-reporting annotations.`);
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
 * `onChunk` fires at every chunk boundary: progress doubles as the worker's
 * liveness heartbeat (stall watchdog + backend janitor), so silence must
 * never span more than one inference call.
 */
async function detectInChunks<T>(
  client: InferenceClient,
  content: string,
  buildPrompt: (chunk: string) => string,
  temperature: number,
  motivation: string,
  parse: (responseText: string) => T[],
  onChunk?: (completedChunks: number, totalChunks: number) => void,
): Promise<T[]> {
  const limits = await client.limits();
  const scaffoldTokens = estimateTokens(buildPrompt(''));
  const { chunking, outputBudget } = deriveDetectionBudget(limits, scaffoldTokens);
  const chunks = chunkText(content, chunking);

  const collected: T[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const response = await boundedGenerateWithMetadata(
      client, buildPrompt(chunks[i]!), outputBudget, temperature, { format: 'json' },
    );
    assertNotTruncated(response, motivation, i + 1, chunks.length);
    collected.push(...parse(response.text));
    if (i < chunks.length - 1) {
      onChunk?.(i + 1, chunks.length);
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
    onChunk?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<CommentMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildCommentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      0.4, 'comment',
      (text) => MotivationParsers.parseComments(text, content),
      onChunk,
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
    onChunk?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<HighlightMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildHighlightPrompt(chunk, instructions, density, sourceLanguage),
      0.3, 'highlight',
      (text) => MotivationParsers.parseHighlights(text, content),
      onChunk,
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
    onChunk?: (completedChunks: number, totalChunks: number) => void,
  ): Promise<AssessmentMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildAssessmentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      0.3, 'assessment',
      (text) => MotivationParsers.parseAssessments(text, content),
      onChunk,
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
    onChunk?: (completedChunks: number, totalChunks: number) => void,
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
      0.2, 'tag',
      (text) => MotivationParsers.parseTags(text),
      onChunk,
    );
    return MotivationParsers.validateTagOffsets(parsedTags, content, category);
  }
}
