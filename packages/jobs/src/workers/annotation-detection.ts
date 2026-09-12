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
import { estimateTokens, type UnitCursor } from '@semiont/core';
import { boundedGenerateStructured } from './inference-call';
import { assertNotTruncated, callChunkSubdividing, deriveDetectionBudget, runAdaptiveChunks, DETECTION_TEMPERATURE } from './detection/detection-chunking';
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
 * Per-chunk detection loop shared by the four motivations.
 *
 * Budgets derive from the provider's actual limits plus the measured prompt
 * scaffold (`buildPrompt('')`) — no literals. The prompt receives one chunk;
 * `parse` reconciles against the FULL document (the callers close over it),
 * so offsets index into the whole resource with no re-anchoring arithmetic.
 * Overlap duplicates pass through — the processor's span-keyed seen-set is
 * the single dedupe point.
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
  motivation: string,
  elementSchema: ElementSchema,
  parse: (items: unknown[]) => T[],
  onActivity?: (consumedChars: number, totalChars: number) => void,
  /**
   * This chunk's parsed matches, awaited before the loop continues: the
   * caller commits them, and the loop must not run ahead of durability.
   * Unlike `onActivity` (a liveness heartbeat, which may repeat), this fires
   * exactly once per chunk, including the last.
   *
   * `cursor` is where the run stands once this chunk is committed — handed over
   * WITH the results so a caller cannot record a position it has not made
   * durable (CHUNK-GRAIN-RESUME P2).
   */
  /** Where an earlier attempt left this unit (CHUNK-GRAIN-RESUME P3).
   * Before the callback below, which stays last. */
  resume?: UnitCursor,
  onChunkResults?: (parsed: T[], cursor: UnitCursor) => Promise<void>,
): Promise<T[]> {
  const limits = await client.limits();
  const scaffoldTokens = estimateTokens(buildPrompt(''));
  // One motivation's spans per call — the single span family this prompt
  // asks for, the motivation-path analogue of one entity type.
  const budget = deriveDetectionBudget(limits, scaffoldTokens, 1);
  const { outputBudget } = budget;

  const collected: T[] = [];
  await runAdaptiveChunks(content, budget, async ({ piece: chunk, size, at, next, totalChars }) => {
    // Structured surface: parsed elements or a throw — an unreadable model
    // response fails the job rather than reading as an empty detection. A
    // size-shaped failure (duration bound, truncation) subdivides in place
    // and retries smaller before it is allowed to fail the job.
    const { items, outcome } = await callChunkSubdividing<unknown>(
      motivation, chunk, { chunkSize: size, overlap: budget.chunking.overlap },
      async (piece) => {
        const response = await boundedGenerateStructured<unknown>(
          client, buildPrompt(piece), outputBudget, DETECTION_TEMPERATURE, elementSchema,
          // Still alive, same position (a long single call is otherwise silent).
          () => onActivity?.(at, totalChars),
        );
        assertNotTruncated(response, `${motivation} detection`, at, totalChars, outputBudget);
        // Usage rides back so the telemetry record carries what the call COST
        // beside what it yielded — the provider's own counts, not an estimate.
        return { items: response.items, ...(response.usage ? { usage: response.usage } : {}) };
      },
    );
    const fromChunk = parse(items);
    collected.push(...fromChunk);
    await onChunkResults?.(fromChunk, { next, size });
    // Chunk boundary: the cursor advances (real progress). Only when text
    // remains — the final cut has no boundary after it, and the caller reports
    // the unit's completion itself.
    if (next < totalChars) onActivity?.(next, totalChars);
    return outcome;
  }, resume);
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
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /** This chunk's matches, as the chunk completes. */
    /** Where an earlier attempt left this unit (CHUNK-GRAIN-RESUME P3). */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: CommentMatch[], cursor: UnitCursor) => Promise<void>,
  ): Promise<CommentMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildCommentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      'comment', COMMENT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseComments(items, content),
      onActivity,
      resume,
      onChunkResults,
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
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /** This chunk's matches, as the chunk completes. */
    /** Where an earlier attempt left this unit (CHUNK-GRAIN-RESUME P3). */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: HighlightMatch[], cursor: UnitCursor) => Promise<void>,
  ): Promise<HighlightMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildHighlightPrompt(chunk, instructions, density, sourceLanguage),
      'highlight', HIGHLIGHT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseHighlights(items, content),
      onActivity,
      resume,
      onChunkResults,
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
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /** This chunk's matches, as the chunk completes. */
    /** Where an earlier attempt left this unit (CHUNK-GRAIN-RESUME P3). */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: AssessmentMatch[], cursor: UnitCursor) => Promise<void>,
  ): Promise<AssessmentMatch[]> {
    return detectInChunks(
      client, content,
      (chunk) => MotivationPrompts.buildAssessmentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      'assessment', ASSESSMENT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseAssessments(items, content),
      onActivity,
      resume,
      onChunkResults,
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
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /**
     * This chunk's matches, ANCHORED before they leave: `parse` here yields
     * raw tags, so this path runs `validateTagOffsets` per chunk — a per-item
     * anchor against the full document, so partitioning changes nothing.
     */
    /** Where an earlier attempt left this unit (CHUNK-GRAIN-RESUME P3). */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: TagMatch[], cursor: UnitCursor) => Promise<void>,
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
      'tag', TAG_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseTags(items),
      onActivity,
      resume,
      onChunkResults
        ? async (raw, cursor) => onChunkResults(MotivationParsers.validateTagOffsets(raw, content, category), cursor)
        : undefined,
    );
    return MotivationParsers.validateTagOffsets(parsedTags, content, category);
  }
}
