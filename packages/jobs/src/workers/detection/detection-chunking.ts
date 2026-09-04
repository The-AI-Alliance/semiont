/**
 * Detection budget derivation — pure window arithmetic over the inference
 * provider's published limits. No hand-tuned chunk constants, no density or
 * yield modeling: document content never enters this arithmetic. The guard
 * for the pathological tail (a chunk whose annotation JSON still overflows
 * the output budget) is `assertNotTruncated` below — invoked per chunk by
 * the callers on every response, not a prediction here.
 *
 * Provider shapes (see `@semiont/inference` interface.ts):
 * - Shared window (Ollama): the provider publishes
 *   `maxOutputTokens === contextTokens` — prompt and response share one
 *   `num_ctx`. What remains after the prompt scaffold is split
 *   input:output = 1:2 (annotation JSON echoes each span plus a fixed
 *   key/context envelope, so output needs the larger share). The 1:2 ratio
 *   is the plan's one allocation policy — doc-independent, tuned only on
 *   live evidence.
 * - Separate ceilings (Anthropic): output takes its full ceiling (duration-
 *   capped below), and input follows the same 1:2 allocation — never more
 *   than half the output budget. Input does NOT get "the rest of the
 *   window": measured 2026-09-02, a window-sized chunk of entity-dense text
 *   demands more output than any budget holds, so the model grinds toward
 *   max_tokens for minutes (killed at the call bound as a "stall") or
 *   collapses to the degenerate []. Large documents chunk; that is the fix,
 *   not a cost.
 */

import { chunkText, type ChunkingConfig, type Logger } from '@semiont/core';
import { StructuredReadError, type InferenceLimits, type TokenUsage } from '@semiont/inference';
import { recordDetectionCall } from '@semiont/observability';
import { DeterministicJobError } from '../../failure-class';
import { INFERENCE_TIMEOUT_MS, InferenceTimeoutError } from '../inference-call';

/**
 * A `max_tokens` stop reason means the model's JSON was cut off mid-stream.
 * Structured output serializes whatever was generated, so that still yields
 * a syntactically-valid but incomplete array — it would parse cleanly and
 * silently under-report. Fail the job loudly instead. With derived budgets
 * this fires only on pathological annotation density.
 *
 * ONE decider for every detection path (entity extraction and the four
 * motivations) — the classification must not diverge between them: same
 * input truncates the same way, so a retry is guaranteed waste and the
 * throw carries the deterministic class (ABANDONED-INFERENCE P3, A4).
 */
export function assertNotTruncated(response: { stopReason: string }, label: string, chunk: number, totalChunks: number, outputBudget: number): void {
  if (response.stopReason === 'max_tokens') {
    throw new DeterministicJobError(`${label} response truncated (max_tokens) on chunk ${chunk}/${totalChunks} despite the derived output budget of ${outputBudget} tokens — failing the job rather than under-reporting annotations.`);
  }
}

/**
 * `reconcileSelector` disambiguates a span with up to 64 chars of prefix and
 * 64 of suffix (the annotation-selector schema). Overlap must let a span
 * sitting at a chunk boundary carry that context — plus a span allowance of
 * the same order — into the adjacent chunk. Schema-derived, not tuned.
 */
const SELECTOR_CONTEXT_CHARS = 64;
const OVERLAP_CHARS =
  SELECTOR_CONTEXT_CHARS + // prefix
  SELECTOR_CONTEXT_CHARS + // suffix
  2 * SELECTOR_CONTEXT_CHARS; // span allowance
/** ~4 chars/token — the same heuristic `estimateTokens`/`chunkText` use. */
const OVERLAP_TOKENS = Math.ceil(OVERLAP_CHARS / 4);

/**
 * One temperature for every detection call. Detection copies spans verbatim
 * against a closed type vocabulary — a fidelity task, so determinism is the
 * right default (reproducible re-runs). Measured equal to hotter settings
 * on yield and consistency at production call sizes.
 */
export const DETECTION_TEMPERATURE = 0;

/**
 * How many entity types one reference-detection job runs at once
 * (DETECTION-QUALITY-THROUGHPUT P6). The types are independent units, and a
 * single sequential job uses a sliver of any provider's rate limit (~1 request
 * / 72 s measured), so concurrency is a near-linear wall-time win up to that
 * limit — the sequential type loop was the 9×-sequential ≈ 2.5 h/document.
 *
 * Deliberately CONSERVATIVE and fixed for the first cut: the plan is start
 * small, measure the real speedup and any 429s against P1 telemetry, and raise
 * only on evidence — never fan out unbounded, which trades sequential waiting
 * for 429 thrash. This is a policy constant, and the natural candidate to
 * become user/admin-tunable per inference provider (a fast, cheap model
 * tolerates more) — same status and future as `DETECTION_TEMPERATURE` and the
 * chunk-sizing policy; homed here so there is one place to make it so.
 */
export const DETECTION_TYPE_CONCURRENCY = 4;

export interface DetectionBudget {
  /** Feed to `chunkText` — `chunkSize` is the derived input budget (tokens). */
  chunking: ChunkingConfig;
  /** Pass as `maxTokens` on every per-chunk inference call. */
  outputBudget: number;
}

/**
 * Derive the per-call input/output token budgets for a detection job from the
 * provider's actual limits and the measured prompt scaffold.
 *
 * @param limits - the provider's published ceilings (`client.limits()`)
 * @param scaffoldTokens - tokens of the prompt template around the content,
 *   measured from the actually-built template (e.g. `estimateTokens(build(''))`)
 * @param typesPerCall - how many entity types (or equivalent span families)
 *   ONE call asks for: output demand scales with it, so the allocation
 *   divides by it. The per-type loop passes 1; a future multi-type batch
 *   passes its batch size.
 * @throws when the window is too small to hold the scaffold plus a useful
 *   chunk — fail-loud, same family as the truncation and window guards.
 */
export function deriveDetectionBudget(
  limits: InferenceLimits,
  scaffoldTokens: number,
  typesPerCall: number,
): DetectionBudget {
  const { contextTokens, maxOutputTokens } = limits;
  const available = contextTokens - scaffoldTokens;

  let inputBudget: number;
  let outputBudget: number;

  if (maxOutputTokens >= contextTokens) {
    // Shared window: 1:2 input:output split of what the scaffold leaves.
    inputBudget = Math.floor(available / 3);
    outputBudget = available - inputBudget;
  } else {
    outputBudget = maxOutputTokens;
    inputBudget = contextTokens - outputBudget - scaffoldTokens;
    if (inputBudget <= 0) {
      // Degenerate separate-ceilings shape (output ceiling nearly fills the
      // window): fall back to the shared split rather than starving input.
      inputBudget = Math.floor(available / 3);
      outputBudget = available - inputBudget;
    }
  }

  // Duration floor (ABANDONED-INFERENCE P4, HD3): when the provider
  // publishes its worst-case output rate, cap each call's output at what
  // that rate finishes inside our own inference bound — a call projected
  // past the 10-minute guillotine is planned-to-fail — and scale input by
  // the same factor, so the input:output ratio (and with it the per-chunk
  // truncation risk profile) is exactly the capacity solution's. Capacity
  // says what CAN fit in one call; this says what SHOULD. Derived end to
  // end — rate from `limits()`, deadline from INFERENCE_TIMEOUT_MS — so
  // #1121's no-hand-tuned-caps principle is extended, not violated; it is
  // a floor on chunk count, never a raise (a tighter capacity budget is
  // left alone). Side effect worth knowing: on Anthropic this lands every
  // detection call at or under the SDK's non-streaming threshold — off the
  // MessageStream path the original `terminated` failure arrived on.
  if (limits.outputTokensPerHour !== undefined) {
    // Half the bound, not all of it: at the full bound the slowest
    // legitimate full-budget generation lands exactly on the guillotine.
    // At half, the guillotine fires only on calls at least 2× slower than
    // the provider's own worst-case model — wedged, not working.
    const durationSafeOutput = Math.floor(limits.outputTokensPerHour * (INFERENCE_TIMEOUT_MS / 2) / 3_600_000);
    if (outputBudget > durationSafeOutput) {
      inputBudget = Math.floor(inputBudget * (durationSafeOutput / outputBudget));
      outputBudget = durationSafeOutput;
    }
  }

  // The 1:2 allocation policy, applied to every provider shape (the shared
  // split satisfies it by construction; separate ceilings did not). Output
  // must hold an annotation echo of every span in the chunk plus its
  // key/context envelope, so a chunk larger than half the output budget is
  // a call whose honest answer cannot fit — the failure measured live on
  // 2026-09-02 (silent multi-minute grinds to max_tokens, degenerate []).
  // The demand is PER TYPE ASKED FOR, so a K-type call divides the input
  // share by K. Still no density modeling: same one policy, content never
  // enters.
  inputBudget = Math.min(inputBudget, Math.floor(outputBudget / (2 * typesPerCall)));

  if (inputBudget <= OVERLAP_TOKENS) {
    throw new Error(
      `Inference window too small for detection: context ${contextTokens} tokens minus scaffold ${scaffoldTokens} leaves an input budget of ${inputBudget} (need > ${OVERLAP_TOKENS}). Use a model with a larger context window or reduce the prompt scaffold.`,
    );
  }

  return {
    chunking: { chunkSize: inputBudget, overlap: OVERLAP_TOKENS },
    outputBudget,
  };
}

/**
 * Depth cap for TIMEOUTS only: a call still timing out on a quarter-sized
 * chunk is not a size problem, and timeouts classify transient — the
 * job-level retry is their second chance. Truncations descend by size
 * instead (see `callChunkSubdividing`).
 */
export const MAX_SUBDIVISION_DEPTH = 2;

/** The failures a smaller chunk can plausibly fix. An unreadable response
 * that stopped naturally is model misbehavior, not size. */
function subdividable(error: unknown): boolean {
  return error instanceof InferenceTimeoutError || truncation(error);
}

/** Truncation in either surface: parsed-but-flagged (`assertNotTruncated`'s
 * `DeterministicJobError`) or cut off mid-JSON (`StructuredReadError` with
 * `max_tokens`). */
function truncation(error: unknown): boolean {
  return (
    error instanceof DeterministicJobError ||
    (error instanceof StructuredReadError && error.stopReason === 'max_tokens')
  );
}

/**
 * Run one chunk's inference call, subdividing IN PLACE when it fails in a
 * way a smaller chunk can fix — instead of burning the whole attempt to
 * come back at the same size. Sub-pieces re-use the caller's overlap, so
 * spans straddling a split are caught twice and fall to the downstream
 * span-keyed dedupe. On a failure subdivision cannot fix, the ORIGINAL
 * error propagates so classification sees what actually happened.
 */
export interface ChunkCallResult<T> {
  items: T[];
  /** The provider's own token counts, when it reported any. Never estimated. */
  usage?: TokenUsage;
}

/** Which shape of failure this was — they demand opposite responses, so the
 * history must tell them apart: truncation descends by size, a timeout fails
 * fast, anything else is not size-shaped at all. */
function outcomeOf(error: unknown): 'truncated' | 'timeout' | 'error' {
  if (truncation(error)) return 'truncated';
  if (error instanceof InferenceTimeoutError) return 'timeout';
  return 'error';
}

export async function callChunkSubdividing<T>(
  label: string,
  chunk: string,
  chunking: ChunkingConfig,
  call: (piece: string) => Promise<ChunkCallResult<T>>,
  logger?: Logger,
): Promise<T[]> {
  // One telemetry record per model call, successes AND failures
  // (DETECTION-QUALITY-THROUGHPUT P1). This is the only place `depth` and
  // `reroll` exist, so it is the only place a complete record can be written.
  async function recorded(piece: string, depth: number, reroll: boolean): Promise<ChunkCallResult<T>> {
    const start = performance.now();
    try {
      const result = await call(piece);
      recordDetectionCall({
        label, pieceChars: piece.length, durationMs: performance.now() - start,
        items: result.items.length, depth, reroll, outcome: 'success',
        ...(result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : {}),
      });
      return result;
    } catch (error) {
      // A failed call still cost its input and its wall time — the descent's
      // price is invisible without it.
      recordDetectionCall({
        label, pieceChars: piece.length, durationMs: performance.now() - start,
        items: 0, depth, reroll, outcome: outcomeOf(error),
      });
      throw error;
    }
  }

  async function attempt(piece: string, chunkSize: number, depth: number): Promise<T[]> {
    try {
      return (await recorded(piece, depth, false)).items;
    } catch (error) {
      if (!subdividable(error)) throw error;
      const half = Math.floor(chunkSize / 2);
      // Truncation descends by SIZE: demand halves with each subdivision,
      // so descent terminates — and list-dense text (registers, indexes)
      // honestly yields several times its input in annotation output, so
      // the descent must go as deep as the content demands. The floor
      // derives from the overlap constant; below it even solid names fit
      // the budget. Timeouts stay depth-capped and fail fast.
      const canDescend = truncation(error)
        ? half > 2 * OVERLAP_TOKENS
        : depth < MAX_SUBDIVISION_DEPTH;
      if (!canDescend) {
        // At the size floor honest overflow is impossible, so truncation
        // here is a degeneration loop — a sampling accident. One same-size
        // re-roll; a second truncation propagates. Timeouts get no re-roll.
        if (!truncation(error)) throw error;
        logger?.warn('Floor-size piece truncated — re-rolling once before giving up', {
          pieceChars: piece.length,
          error: error instanceof Error ? error.message : String(error),
        });
        return (await recorded(piece, depth, true)).items;
      }
      logger?.warn('Chunk call failed at a size-shaped bound — subdividing and retrying smaller', {
        depth: depth + 1,
        pieceChars: piece.length,
        nextChunkSizeTokens: half,
        error: error instanceof Error ? error.message : String(error),
      });
      const pieces = chunkText(piece, { chunkSize: half, overlap: chunking.overlap });
      const collected: T[] = [];
      for (const p of pieces) {
        collected.push(...(await attempt(p, half, depth + 1)));
      }
      return collected;
    }
  }
  return attempt(chunk, chunking.chunkSize, 0);
}
