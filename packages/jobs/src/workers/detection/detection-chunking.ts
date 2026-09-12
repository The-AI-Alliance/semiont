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

import { chunkText, cutChunk, type ChunkingConfig, type Logger, type UnitCursor } from '@semiont/core';
import { StructuredReadError, type InferenceLimits, type TokenUsage } from '@semiont/inference';
import { recordDetectionCall } from '@semiont/observability';
import { DeterministicJobError } from '../../failure-class';
import { INFERENCE_TIMEOUT_MS, InferenceTimeoutError } from '../inference-call';
import { nextChunkSize, type CallOutcome, type SizingBounds } from './chunk-size-controller';

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
export function assertNotTruncated(response: { stopReason: string }, label: string, at: number, totalChars: number, outputBudget: number): void {
  if (response.stopReason === 'max_tokens') {
    throw new DeterministicJobError(`${label} response truncated (max_tokens) at character ${at} of ${totalChars} despite the derived output budget of ${outputBudget} tokens — failing the job rather than under-reporting annotations.`);
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
 * Assumed worst-case output rate for providers that publish none
 * (OLLAMA-DETECTION-TESTING P3b, from F9). Rate-silent providers (Ollama —
 * local hardware, rate unknowable a priori) previously got NO duration bound:
 * capacity-sizing handed a 262K-window model a ~174K-token output budget, and
 * a repetition loop then burned the full 10-minute guillotine as TRANSIENT —
 * retried identically. Under a duration-shaped cap the same loop dies in
 * minutes as max_tokens → deterministic → subdividable: the useful failure.
 *
 * 30 tok/s. P2 measured 36–90 tok/s across three local model families
 * (qwen3.5:9b ~36, gemma4:26b ~50, gemma4:e2b ~90), and the half-bound rule
 * in the cap below means real rates down to 15 tok/s still finish inside the
 * guillotine — anything slower is wedged, not working, which is exactly what
 * the guillotine is for. A conservative floor, deliberately NOT per-model:
 * F8 showed per-model thresholds chase noise. Owned policy constant, same
 * status as the 1:2 split and DETECTION_TEMPERATURE.
 */
export const ASSUMED_OUTPUT_TOKENS_PER_HOUR = 108_000;

/**
 * The count-verifier band (OLLAMA-DETECTION-TESTING P3c, user-ratified
 * 2026-09-05): an extraction that found fewer than 1/BAND of the mentions a
 * cheap count call reports is flagged as silent yield collapse (F7). The band
 * is LOAD-BEARING at 2: F12 measured the same model flipping between
 * entity-like and mention-like enumeration on the same corpus, and that
 * legitimate judgment spread must fit INSIDE the band — probe evidence (n=6)
 * put every healthy ratio at 0.68–0.88 and every collapse at 0.18–0.41.
 */
export const YIELD_COLLAPSE_BAND = 2;

/**
 * The silent-yield-collapse verdict (F7): a schema-clean, done-reason-clean
 * extraction that found a fraction of what a cheap count call says is present.
 * Extends DeterministicJobError because the collapse is MEASURED deterministic
 * — bit-identical across retries and across budget regimes — so a retry is
 * guaranteed waste; the classification and the size-floored subdivision
 * descent both follow from the base class. It diverges from truncation at the
 * size floor: NO re-roll (a same-size re-roll provably returns the identical
 * collapse), and — ruled 2026-09-05 after P4 attempt 1, amending the original
 * fail-the-job invariant — the floor ACCEPTS the flagged piece's `salvage`
 * loudly rather than failing the unit: one hostile ~530-char stretch had
 * discarded ~20 chunks of good extraction, and at floor sizes the count's
 * evidence sits far below anything the probe validated. The warning and the
 * 'collapsed' telemetry rows are the durable record; re-detection heals.
 */
/** A floor-accepted piece's evidence: what extraction found against what a
 * count call reported, over a piece of this size. Facts only — never a
 * judgment against an expected yield. */
export interface UnderReportedPiece {
  found: number;
  counted: number;
  pieceChars: number;
}

export class YieldCollapseError extends DeterministicJobError {
  override readonly name = 'YieldCollapseError';
  /** What the flagged extraction DID find — every span write-time-verified,
   * so discarding it at the floor would add loss on top of the under-report.
   * Carried on the error because the flag site cannot know whether descent
   * remains possible; the floor is the subdivider's knowledge. The verdict
   * rides beside it so an acceptance can report evidence, not a message
   * string. */
  constructor(message: string, readonly salvage: unknown[], readonly verdict: UnderReportedPiece) {
    super(message);
  }
}

export interface DetectionBudget {
  /** The chunk size a run OPENS at (tokens), plus the overlap every cut keeps.
   * Opening, not fixed: `runAdaptiveChunks` moves the size within `bounds` as
   * the document reports what it actually costs. */
  chunking: ChunkingConfig;
  /** Pass as `maxTokens` on every per-chunk inference call. */
  outputBudget: number;
  /** How far the sizer may move the chunk size, in either direction. Derived
   * from the same provider arithmetic — never tuning. */
  bounds: SizingBounds;
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

  // Duration floor (ABANDONED-INFERENCE P4 HD3; universalized by
  // OLLAMA-DETECTION-TESTING P3b): cap each call's output at what the
  // provider's worst-case rate finishes inside our own inference bound — a
  // call projected past the 10-minute guillotine is planned-to-fail — and
  // scale input by the same factor, so the input:output ratio (and with it
  // the per-chunk truncation risk profile) is exactly the capacity
  // solution's. Capacity says what CAN fit in one call; this says what
  // SHOULD. EVERY provider gets the bound: the published rate when there is
  // one, the conservative assumed floor when there is not — a rate-silent
  // provider with no bound turned repetition loops into hour-long transient
  // burns (F9; see ASSUMED_OUTPUT_TOKENS_PER_HOUR). It is a floor on chunk
  // count, never a raise (a tighter capacity budget is left alone). Side
  // effect worth knowing: on Anthropic this lands every detection call at
  // or under the SDK's non-streaming threshold — off the MessageStream path
  // the original `terminated` failure arrived on.
  const outputTokensPerHour = limits.outputTokensPerHour ?? ASSUMED_OUTPUT_TOKENS_PER_HOUR;
  {
    // Half the bound, not all of it: at the full bound the slowest
    // legitimate full-budget generation lands exactly on the guillotine.
    // At half, the guillotine fires only on calls at least 2× slower than
    // the provider's own worst-case model — wedged, not working.
    const durationSafeOutput = Math.floor(outputTokensPerHour * (INFERENCE_TIMEOUT_MS / 2) / 3_600_000);
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
  // The window fit: the largest input that still leaves the WHOLE output budget
  // room beside it. This is the sizer's ceiling, and it is the only hard bound
  // on input there is — the two derivations above are not.
  //
  // The 1:2 rule below is a GUESS about how much output a chunk will demand,
  // and on a shared window it is baked into the 1:3 split as well, which is why
  // the ceiling cannot be read off either of them (both come back at exactly
  // the guess, leaving no room to grow into on precisely the self-hosted
  // providers the live gate runs). The duration bound is real but bounds
  // GENERATION, so it belongs to `outputBudget`; it reaches input only through
  // the same ratio guess. `nextChunkSize` exists to replace that guess with
  // measurement, so the guess opens the run and the window caps it.
  const capacityInput = contextTokens - scaffoldTokens - outputBudget;

  inputBudget = Math.min(inputBudget, Math.floor(outputBudget / (2 * typesPerCall)));

  if (inputBudget <= OVERLAP_TOKENS) {
    throw new Error(
      `Inference window too small for detection: context ${contextTokens} tokens minus scaffold ${scaffoldTokens} leaves an input budget of ${inputBudget} (need > ${OVERLAP_TOKENS}). Use a model with a larger context window or reduce the prompt scaffold.`,
    );
  }

  return {
    chunking: { chunkSize: inputBudget, overlap: OVERLAP_TOKENS },
    outputBudget,
    bounds: {
      // Two overlaps: at the floor a chunk is still half text it has not seen
      // before, so the cursor keeps making progress rather than re-reading its
      // own tail. Clamped under the opening size, because a cramped window can
      // derive an opening below even that — and a floor above the opening would
      // clamp every proposal upward, silently reversing the sizer.
      floor: Math.min(inputBudget, 2 * OVERLAP_TOKENS),
      // Never below the opening: a degenerate window can make the fit
      // arithmetic smaller than the size already chosen, and a ceiling under
      // the opening would clamp every proposal DOWN on the first call.
      ceiling: Math.max(inputBudget, capacityInput),
      outputBudget,
    },
  };
}

/** One chunk handed out by `runAdaptiveChunks`, with the cursor either side of
 * it. `at`/`next` over `totalChars` is exact progress — and, once
 * CHUNK-GRAIN-RESUME lands, the checkpoint identity a variable boundary forces
 * (an ordinal cannot name a chunk whose size is decided while the job runs). */
/**
 * The half of a `UnitCursor` the DETECTION layer can honestly report: where the
 * walk stands and how it is cutting. The tallies belong to the processor, which
 * owns unit identity and unit counts — this loop counts chunks, not annotations,
 * and a zero it invented would be indistinguishable from a real one.
 */
export type ChunkCursor = Pick<UnitCursor, 'next' | 'size'>;

export interface AdaptiveChunk {
  piece: string;
  /** The token size this piece was cut at. Hand it to `callChunkSubdividing`:
   * a descent halves from the size that actually failed, not from the size the
   * run opened at, which adaptivity has long since left behind. */
  size: number;
  /** Characters consumed BEFORE this chunk — the in-flight liveness position. */
  at: number;
  /** Characters consumed once this chunk completes — the boundary position. */
  next: number;
  /** The document's length. */
  totalChars: number;
}

/**
 * Walk a document in chunks whose size is decided by the chunks before them.
 *
 * `chunkText` fixes every boundary up front from provider limits alone, which
 * is why the sizing rule could exist for a week and change nothing: a
 * measurement taken on chunk N had nowhere to land. Here chunk N+1 is cut only
 * after chunk N has reported, so the run opens at the static density guess and
 * then moves — a sparse document climbing toward the window's real capacity
 * (fewer, bigger calls), a dense one easing off before it pays a subdivision.
 *
 * `onChunk` returns what the chunk cost. It is awaited, so the caller's own
 * durability (committing the chunk's annotations) still gates the next cut, and
 * a throw stops the walk where it stands rather than advancing past unprocessed
 * text.
 *
 * `resume` restarts a unit an earlier attempt left partway (CHUNK-GRAIN-RESUME
 * P3) — the checkpoint P2 made durable, spent. Both halves of it matter and they
 * are spent differently: the position is taken as given, while the size is
 * seeded and then stepped ONCE, as if the last outcome had been a failure. It
 * was: the job died. Opening at the budget instead would throw away the
 * calibration the dead attempt paid for over its earlier chunks, and seeding
 * unchanged would re-cut the identical piece — which at `DETECTION_TEMPERATURE`
 * 0 returns the identical answer, failure included (HD2, option C).
 */
export async function runAdaptiveChunks(
  text: string,
  budget: DetectionBudget,
  onChunk: (chunk: AdaptiveChunk) => Promise<CallOutcome>,
  resume?: UnitCursor,
): Promise<void> {
  let at = resume?.next ?? 0;
  let size = resume
    ? nextChunkSize({ truncated: true }, resume.size, budget.bounds)
    : budget.chunking.chunkSize;

  while (at < text.length) {
    const { piece, next } = cutChunk(text, at, { chunkSize: size, overlap: budget.chunking.overlap });
    const outcome = await onChunk({ piece, size, at, next, totalChars: text.length });
    at = next;
    size = nextChunkSize(outcome, size, budget.bounds);
  }
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
/** The F3 shape: unreadable output whose stop reason is UNKNOWN (done_reason
 * absent). Held not-subdividable through P3a for lack of evidence; the live
 * gate then reproduced it twice on real text (2026-09-03 at ~21K chars, P4
 * attempt 2 at ~4.5K, mid-descent, adjacent to max_tokens truncations that
 * healed by subdividing) and measured the retry-at-same-size alternative as a
 * deterministic 34 s burn. Size-shaped on the evidence — descends like
 * truncation, but with no floor re-roll (near-deterministic, nothing salvaged)
 * and unchanged retryable classification (a genuinely broken server still
 * deserves its budget). */
function unknownUnreadable(error: unknown): boolean {
  return error instanceof StructuredReadError && error.stopReason === 'unknown';
}

/**
 * The model FINISHED and still emitted unparseable JSON — not cut off, not
 * stopped for an unknown reason. Subdividable, but DEPTH-capped rather than
 * size-floored, and the two halves of that are separately earned:
 *
 * Subdividable, because one of these killed a 26-minute attempt at chunk 25 of
 * 49 while the preceding 24 chunks parsed cleanly on the same prompt and model
 * — so the malformation was content-triggered drift, which changing the input
 * can fix. A same-size retry cannot: DETECTION_TEMPERATURE is 0, so the
 * identical call returns the identical response (the same reason a collapse
 * verdict gets no re-roll).
 *
 * Depth-capped rather than size-floored, because if the drift is instead
 * systematic — the model answering this prompt shape wrongly everywhere — every
 * extra level re-reads the same content for the same verdict. Measured, the two
 * settings often coincide (the descent aborts at the first failing sub-piece
 * instead of exploring siblings, so cost is linear in depth, not geometric),
 * and where they differ the cap is the cheaper wrong answer. Timeouts are
 * capped on the same reasoning.
 */
function unreadableDespiteFinishing(error: unknown): boolean {
  return error instanceof StructuredReadError && error.stopReason === 'end_turn';
}

function subdividable(error: unknown): boolean {
  return error instanceof InferenceTimeoutError || truncation(error)
    || unknownUnreadable(error) || unreadableDespiteFinishing(error);
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
/** What `callChunkSubdividing` produced AND what it cost — the second half is
 * what `runAdaptiveChunks` sizes the next chunk from. Accumulated across the
 * whole descent, because the caller's own `call` closure sees one piece at a
 * time and cannot know a subdivision happened at all. */
export interface SubdividedCall<T> {
  items: T[];
  outcome: CallOutcome;
}

export interface ChunkCallResult<T> {
  items: T[];
  /** The provider's own token counts, when it reported any. Never estimated. */
  usage?: TokenUsage;
  /** The count-verifier's expectation for this piece, when one was priced. */
  counted?: number;
}

/** Which shape of failure this was — they demand opposite responses, so the
 * history must tell them apart: truncation descends by size, a timeout fails
 * fast, anything else is not size-shaped at all. */
function outcomeOf(error: unknown): 'truncated' | 'timeout' | 'collapsed' | 'error' {
  // Collapse before truncation: it IS a DeterministicJobError (so the
  // truncation check would swallow it), but in the history the two are
  // different facts — one is output overflow, the other silent under-report.
  if (error instanceof YieldCollapseError) return 'collapsed';
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
  /** A floor-accepted piece's evidence, as it is accepted. Only the floor
   * reports: a collapse healed by descent is telemetry, not result. */
  onUnderReport?: (verdict: UnderReportedPiece) => void,
  /** Each ACCEPTED piece's count-verifier expectation — successes, floor
   * re-rolls, floor-accepted salvage. A flagged piece that descends reports
   * nothing: its children's counts replace it, or the same text is priced
   * twice. */
  onCounted?: (counted: number) => void,
): Promise<SubdividedCall<T>> {
  // The chunk's cost, summed over however many calls its descent takes. Both
  // are recorded where EVERY call passes, so a subdivision cannot hide from
  // them.
  let outputTokens = 0;
  let sizeShaped = false;
  // A descent's calls must ALL report usage for the sum to mean anything: a
  // partial sum under-counts, and under-counting biases toward growth — the
  // one direction that costs a truncation to discover was wrong.
  let callsMade = 0;
  let callsMeasured = 0;
  // One telemetry record per model call, successes AND failures
  // (DETECTION-QUALITY-THROUGHPUT P1). This is the only place `depth` and
  // `reroll` exist, so it is the only place a complete record can be written.
  async function recorded(piece: string, depth: number, reroll: boolean): Promise<ChunkCallResult<T>> {
    const start = performance.now();
    try {
      const result = await call(piece);
      callsMade += 1;
      if (result.usage) {
        callsMeasured += 1;
        outputTokens += result.usage.outputTokens;
      }
      recordDetectionCall({
        label, pieceChars: piece.length, durationMs: performance.now() - start,
        items: result.items.length, depth, reroll, outcome: 'success',
        ...(result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : {}),
      });
      // A success is always accepted — only failures subdivide.
      if (result.counted !== undefined) onCounted?.(result.counted);
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
      // Size-shaped, so the size was wrong — true whether or not the descent
      // below rescues it. The next chunk must not be cut at a size this one
      // already paid to discover was too big.
      sizeShaped = true;
      const half = Math.floor(chunkSize / 2);
      // Truncation descends by SIZE: demand halves with each subdivision,
      // so descent terminates — and list-dense text (registers, indexes)
      // honestly yields several times its input in annotation output, so
      // the descent must go as deep as the content demands. The floor
      // derives from the overlap constant; below it even solid names fit
      // the budget. Timeouts stay depth-capped and fail fast.
      //
      // A descent must also actually CHANGE the input: once a piece fits
      // inside the smaller chunk size, re-chunking returns it unchanged, and
      // at temperature 0 the identical call returns the identical failure —
      // measured live (P4 attempt 1: one 572-char piece "descended" through
      // three depths, same verdict each time). A piece that cannot shrink is
      // AT its floor, whatever the arithmetic floor says.
      const pieces = chunkText(piece, { chunkSize: half, overlap: chunking.overlap });
      const shrinks = pieces.length > 1 || pieces[0] !== piece;
      // Size-shaped failures (truncation, collapse, the F3 unknown-unreadable)
      // descend to the SIZE floor; only timeouts are depth-capped — the F3 fix
      // must reach failures that first appear mid-descent (measured at depth 3).
      const canDescend = shrinks && (truncation(error) || unknownUnreadable(error)
        ? half > 2 * OVERLAP_TOKENS
        : depth < MAX_SUBDIVISION_DEPTH);
      if (!canDescend) {
        // A collapse verdict at the floor is ACCEPTED, loudly (ruled
        // 2026-09-05): its salvage flows through with a warning instead of
        // one hostile piece discarding the whole unit's work. No re-roll —
        // the collapse is deterministic, a same-size retry changes nothing.
        if (error instanceof YieldCollapseError) {
          logger?.warn('Floor-size piece still flagged as collapsed — accepting its under-reported salvage and continuing', {
            pieceChars: piece.length,
            salvaged: error.salvage.length,
            error: error.message,
          });
          onUnderReport?.(error.verdict);
          onCounted?.(error.verdict.counted);
          return error.salvage as T[];
        }
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
      const collected: T[] = [];
      for (const p of pieces) {
        collected.push(...(await attempt(p, half, depth + 1)));
      }
      return collected;
    }
  }
  const items = await attempt(chunk, chunking.chunkSize, 0);
  const measured = callsMade > 0 && callsMeasured === callsMade;
  return {
    items,
    outcome: { truncated: sizeShaped, ...(measured ? { outputTokens } : {}) },
  };
}
