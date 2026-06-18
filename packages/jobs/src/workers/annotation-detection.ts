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
 * Post-Phase-1 that still yields a syntactically-valid but incomplete array
 * (structured output serializes whatever was generated), so it would parse
 * cleanly and silently under-report. Fail the job loudly instead — parity
 * with the entity-extractor path.
 */
function assertNotTruncated(response: InferenceResponse, motivation: string): void {
  if (response.stopReason === 'max_tokens') {
    throw new Error(`${motivation} detection response truncated (max_tokens) — increase max_tokens or reduce resource size; failing the job rather than under-reporting annotations.`);
  }
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
    sourceLanguage?: string
  ): Promise<CommentMatch[]> {
    const prompt = MotivationPrompts.buildCommentPrompt(content, instructions, tone, density, language, sourceLanguage);
    const response = await client.generateTextWithMetadata(prompt, 3000, 0.4, { format: 'json' });
    assertNotTruncated(response, 'comment');
    return MotivationParsers.parseComments(response.text, content);
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
    sourceLanguage?: string
  ): Promise<HighlightMatch[]> {
    const prompt = MotivationPrompts.buildHighlightPrompt(content, instructions, density, sourceLanguage);
    const response = await client.generateTextWithMetadata(prompt, 2000, 0.3, { format: 'json' });
    assertNotTruncated(response, 'highlight');
    return MotivationParsers.parseHighlights(response.text, content);
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
    sourceLanguage?: string
  ): Promise<AssessmentMatch[]> {
    const prompt = MotivationPrompts.buildAssessmentPrompt(content, instructions, tone, density, language, sourceLanguage);
    const response = await client.generateTextWithMetadata(prompt, 3000, 0.3, { format: 'json' });
    assertNotTruncated(response, 'assessment');
    return MotivationParsers.parseAssessments(response.text, content);
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
    sourceLanguage?: string
  ): Promise<TagMatch[]> {
    const categoryInfo = schema.tags.find((t) => t.name === category);
    if (!categoryInfo) {
      throw new Error(`Invalid category "${category}" for schema ${schema.id}`);
    }

    const prompt = MotivationPrompts.buildTagPrompt(
      content,
      category,
      schema.name,
      schema.description,
      schema.domain,
      categoryInfo.description,
      categoryInfo.examples,
      sourceLanguage
    );

    const response = await client.generateTextWithMetadata(prompt, 4000, 0.2, { format: 'json' });
    assertNotTruncated(response, 'tag');
    const parsedTags = MotivationParsers.parseTags(response.text);
    return MotivationParsers.validateTagOffsets(parsedTags, content, category);
  }
}
