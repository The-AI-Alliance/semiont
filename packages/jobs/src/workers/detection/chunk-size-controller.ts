/**
 * Adaptive chunk sizing (DETECTION-QUALITY-THROUGHPUT P2) — DRAFT.
 *
 * `deriveDetectionBudget` picks ONE input size for every document from provider
 * limits alone. It cannot see the document, so it is sized for a worst-case
 * dense one (input = half the output budget) — and a sparse document then pays
 * that pessimism as many tiny, overhead-dominated calls. This adjusts the chunk
 * size AS THE UNIT RUNS, from what each call actually produced, so a document
 * that turns out sparse grows into bigger chunks and a dense stretch pulls back.
 *
 * It steers ONE number: how full of the output budget each chunk came in. That
 * is the whole model, and it is enough because both hard failures are already
 * caught downstream by `callChunkSubdividing` — a chunk that truncates is
 * halved-and-retried, a chunk that outruns the guillotine times out and is
 * halved-and-retried. So the sizer does not model truncation or duration; it
 * only keeps chunks in a band that uses the budget well, and the net below it
 * forgives an overshoot. That safety net is why this is a step rule and not a
 * control loop (user direction, 2026-09-04: keep it simple).
 *
 * "Maximize, don't predict": the only thing that grows a chunk is a MEASURED
 * under-use of the budget. No document statistic, no a-priori density model
 * (#1121's ban). Re-evaluated every chunk, so it tracks a gradient (sparse
 * intro → dense index) rather than betting the run on the first sample.
 *
 * Pure and feedback-only — unit-testable in isolation. Wiring into
 * `detectInChunks` (and the checkpoint interaction a variable boundary implies)
 * is the GREEN step, deliberately not here.
 */

/** What one chunk's call produced — the minimum the sizer needs. Duration and
 * input are NOT here: the guillotine and truncation are the hard bounds, both
 * backstopped by subdivision, so utilization is the only signal that sizing
 * acts on. (P1 telemetry records the fuller picture separately.) */
export interface CallOutcome {
  /** Provider-reported output tokens for the chunk. */
  outputTokens: number;
  /** The chunk hit a size-shaped bound (truncation or the guillotine), even if
   * subdivision then recovered it. Forces a shrink regardless of the count —
   * the signal that the last size was too big for this stretch. */
  truncated: boolean;
}

/** Provider-DERIVED sizing bounds for one job — not tuning, not policy. From
 * `deriveDetectionBudget` and the model's window; recomputed per job, never
 * user-facing. */
export interface SizingBounds {
  /** Smallest useful input chunk (tokens) — the overlap-derived floor. */
  floor: number;
  /** Largest input chunk (tokens) — the window-fit safety cap; never exceeded. */
  ceiling: number;
  /** The output budget one call is given. Utilization is measured against it. */
  outputBudget: number;
}

/**
 * The tuning knobs — the numbers that decide how aggressively chunk size chases
 * measured output usage. Grouped and named deliberately, because these are
 * POLICY, not derivation, and the likely future is that they become
 * user/admin-tunable, perhaps per inference provider (a fast, cheap model
 * tolerates more aggressive growth than a slow, dear one).
 *
 * That future changes where a `ChunkSizingPolicy` comes FROM — provider config,
 * a settings surface — not the sizing function, which already takes it as a
 * value, nor the caller's shape. There is exactly ONE today, the default below.
 * No config system, no env var, no per-provider map yet: just a single named
 * home, so when the need is real there is one obvious thing to make configurable
 * and one obvious place to select it (the caller holds the `InferenceClient`,
 * hence the provider).
 */
export interface ChunkSizingPolicy {
  /** Below this fraction of the output budget, the chunk left room — grow. */
  growBelow: number;
  /** Above this fraction, the chunk is near the edge — ease off before it
   * truncates and costs a subdivision retry. */
  shrinkAbove: number;
  /** Geometric step when growing (>1). Geometric so a genuinely sparse document
   * reaches its ceiling in a few steps and a bad step costs one correction. */
  growFactor: number;
  /** Geometric step when easing off (<1). Also the response to a truncation. */
  shrinkFactor: number;
}

/** The one policy in effect today. Coarse on purpose — subdivision forgives a
 * wrong guess — and every value is a candidate for the tunable surface above. */
export const DEFAULT_CHUNK_SIZING_POLICY: ChunkSizingPolicy = {
  growBelow: 0.5,
  shrinkAbove: 0.8,
  growFactor: 1.5,
  shrinkFactor: 0.7,
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Propose the next chunk's input size from what the last chunk produced.
 *
 * A truncated chunk, or one whose output filled more than `shrinkAbove` of the
 * budget, eases the next chunk down; one that used less than `growBelow` grows
 * it; in between, hold. Always clamped to `[floor, ceiling]`. That is the whole
 * rule — the hard bounds are subdivision's job, not this function's.
 */
export function nextChunkSize(
  outcome: CallOutcome,
  current: number,
  bounds: SizingBounds,
  policy: ChunkSizingPolicy = DEFAULT_CHUNK_SIZING_POLICY,
): number {
  const grow = () => clamp(Math.floor(current * policy.growFactor), bounds.floor, bounds.ceiling);
  const shrink = () => clamp(Math.floor(current * policy.shrinkFactor), bounds.floor, bounds.ceiling);
  const hold = () => clamp(current, bounds.floor, bounds.ceiling);

  if (outcome.truncated) return shrink();
  // A zero/absent budget cannot inform utilization; hold rather than divide by
  // zero or grow blindly.
  if (bounds.outputBudget <= 0) return hold();

  const utilization = outcome.outputTokens / bounds.outputBudget;
  if (utilization < policy.growBelow) return grow();
  if (utilization > policy.shrinkAbove) return shrink();
  return hold();
}
