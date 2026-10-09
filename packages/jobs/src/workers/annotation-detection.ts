/**
 * Annotation Detection
 *
 * Orchestrates the full annotation detection pipeline:
 * 1. Build AI prompts using MotivationPrompts
 * 2. Call AI inference
 * 3. Parse and validate results using MotivationParsers
 *
 * All methods take content as a string parameter — the worker process
 * fetches it and hands it in, with its conversions (`textOffsets(content)`),
 * which are made once where the content is first held.
 */

import type { ElementSchema, InferenceClient } from '@semiont/inference';
import { estimateTokens, type Logger, type TextOffsets, type UnitCursor } from '@semiont/core';
import { boundedGenerateStructured } from './inference-call';
import { assertNotTruncated, callChunkSubdividing, deriveDetectionBudget, runAdaptiveChunks, type ChunkCursor, DETECTION_TEMPERATURE } from './detection/detection-chunking';
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
  type Anchored,
} from './detection/motivation-parsers';
import type { TagSchema } from '@semiont/core';

/**
 * Per-chunk detection loop shared by the four motivations.
 *
 * Budgets derive from the provider's actual limits plus the measured prompt
 * scaffold (`buildPrompt('')`) — no literals. The prompt receives one chunk;
 * `parse` reconciles against the FULL document (the callers close over it),
 * so offsets count the whole resource's code points with no re-anchoring
 * arithmetic.
 * Overlap duplicates pass through — the processor's span-keyed seen-set is
 * the single dedupe point.
 *
 * `onActivity` fires whenever the detection is demonstrably alive: at each
 * chunk boundary (the count advances) AND periodically while one inference
 * call is in flight (the count repeats — liveness, not progress). Its two
 * numbers are offsets: where the walk stands and the content's length, in
 * code points. Progress is
 * the worker's liveness heartbeat AND the client's inter-emission timeout
 * signal, so a silent single-chunk run kills a healthy job.
 *
 * `signal` is the held job's cancellation: the walk stops between chunks once
 * it is aborted (`runAdaptiveChunks`), and from then nothing more is reported.
 */
async function detectInChunks<T>(
  client: InferenceClient,
  content: string,
  offsets: TextOffsets,
  logger: Logger,
  signal: AbortSignal,
  buildPrompt: (chunk: string) => string,
  motivation: string,
  elementSchema: ElementSchema,
  parse: (items: unknown[]) => Anchored<T>,
  onActivity?: (consumedChars: number, totalChars: number) => void,
  /** Where an earlier attempt left this unit: a partway unit resumes at its
   * recorded offset instead of the top. Before the callback below, which
   * stays last. */
  resume?: UnitCursor,
  /**
   * This chunk's parsed matches, awaited before the loop continues: the
   * caller commits them, and the loop must not run ahead of durability.
   * Unlike `onActivity` (a liveness heartbeat, which may repeat), this fires
   * exactly once per chunk, including the last.
   *
   * `cursor` is where the run stands once this chunk is committed — handed over
   * WITH the results so a caller cannot record a position it has not made
   * durable.
   */
  onChunkResults?: (kept: T[], cursor: ChunkCursor, dropped: number) => Promise<void>,
): Promise<T[]> {
  const limits = await client.limits();
  const scaffoldTokens = estimateTokens(buildPrompt(''));
  // One motivation's spans per call — the single span family this prompt
  // asks for, the motivation-path analogue of one entity type.
  const budget = deriveDetectionBudget(limits, scaffoldTokens, 1);
  const { outputBudget } = budget;

  const collected: T[] = [];
  await runAdaptiveChunks(content, offsets, budget, signal, async ({ piece: chunk, size, at, next, totalChars }) => {
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
          logger,
        );
        assertNotTruncated(response, `${motivation} detection`, at, totalChars, outputBudget);
        // Usage rides back so the telemetry record carries what the call COST
        // beside what it yielded — the provider's own counts, not an estimate.
        return { items: response.items, ...(response.usage ? { usage: response.usage } : {}) };
      },
      logger,
    );
    const { matches: fromChunk, dropped } = parse(items);
    collected.push(...fromChunk);
    await onChunkResults?.(fromChunk, { next, size }, dropped);
    // Chunk boundary: the cursor advances (real progress). Only when text
    // remains — the final cut has no boundary after it, and the caller reports
    // the unit's completion itself — and only while the job goes on: a
    // cancelled job has stopped with this chunk's checkpoint.
    if (next < totalChars && !signal.aborted) onActivity?.(next, totalChars);
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
    offsets: TextOffsets,
    client: InferenceClient,
    logger: Logger,
    signal: AbortSignal,
    instructions?: string,
    tone?: string,
    density?: number,
    language?: string,
    sourceLanguage?: string,
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /** Where an earlier attempt left this unit. */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: CommentMatch[], cursor: ChunkCursor, dropped: number) => Promise<void>,
  ): Promise<CommentMatch[]> {
    return detectInChunks(
      client, content, offsets, logger, signal,
      (chunk) => MotivationPrompts.buildCommentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      'comment', COMMENT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseComments(items, content, logger),
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
    offsets: TextOffsets,
    client: InferenceClient,
    logger: Logger,
    signal: AbortSignal,
    instructions?: string,
    density?: number,
    sourceLanguage?: string,
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /** Where an earlier attempt left this unit. */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: HighlightMatch[], cursor: ChunkCursor, dropped: number) => Promise<void>,
  ): Promise<HighlightMatch[]> {
    return detectInChunks(
      client, content, offsets, logger, signal,
      (chunk) => MotivationPrompts.buildHighlightPrompt(chunk, instructions, density, sourceLanguage),
      'highlight', HIGHLIGHT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseHighlights(items, content, logger),
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
    offsets: TextOffsets,
    client: InferenceClient,
    logger: Logger,
    signal: AbortSignal,
    instructions?: string,
    tone?: string,
    density?: number,
    language?: string,
    sourceLanguage?: string,
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /** Where an earlier attempt left this unit. */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: AssessmentMatch[], cursor: ChunkCursor, dropped: number) => Promise<void>,
  ): Promise<AssessmentMatch[]> {
    return detectInChunks(
      client, content, offsets, logger, signal,
      (chunk) => MotivationPrompts.buildAssessmentPrompt(chunk, instructions, tone, density, language, sourceLanguage),
      'assessment', ASSESSMENT_ELEMENT_SCHEMA,
      (items) => MotivationParsers.parseAssessments(items, content, logger),
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
    offsets: TextOffsets,
    client: InferenceClient,
    logger: Logger,
    signal: AbortSignal,
    schema: TagSchema,
    category: string,
    sourceLanguage?: string,
    onActivity?: (consumedChars: number, totalChars: number) => void,
    /** Where an earlier attempt left this unit. */
    resume?: UnitCursor,
    /** This chunk's matches, as the chunk completes. Kept LAST. */
    onChunkResults?: (matches: TagMatch[], cursor: ChunkCursor, dropped: number) => Promise<void>,
  ): Promise<TagMatch[]> {
    const categoryInfo = schema.tags.find((t) => t.name === category);
    if (!categoryInfo) {
      throw new Error(`Invalid category "${category}" for schema ${schema.id}`);
    }

    return detectInChunks(
      client, content, offsets, logger, signal,
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
      // Each proposal is anchored once, against the whole document, as the
      // other three motivations' are: what the loop returns is what it handed
      // over, chunk by chunk.
      (items) => MotivationParsers.validateTagOffsets(MotivationParsers.parseTags(items, logger), content, category, logger),
      onActivity,
      resume,
      onChunkResults,
    );
  }
}
