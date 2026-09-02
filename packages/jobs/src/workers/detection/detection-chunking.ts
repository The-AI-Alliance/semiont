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

import type { ChunkingConfig } from '@semiont/core';
import type { InferenceLimits } from '@semiont/inference';
import { DeterministicJobError } from '../../failure-class';
import { INFERENCE_TIMEOUT_MS } from '../inference-call';

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
    const durationSafeOutput = Math.floor(limits.outputTokensPerHour * (INFERENCE_TIMEOUT_MS / 3_600_000));
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
