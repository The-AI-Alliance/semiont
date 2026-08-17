import { SemiontError } from '@semiont/core';

/**
 * The ONE stall guard for generation streams (FLOW-LIFECYCLE-CONVERGENCE D1).
 *
 * The generation wire is exactly three frames (5 → 95 → 100), so the 5→95
 * silence spans the entire inference call. The deadline therefore derives
 * from the request's `maxTokens` — never a fixed constant — because the
 * guard CANCELS server-side, and a mis-sized fixed default would destroy
 * the longest legitimate runs (D1a). Consumers override per call with
 * `GenerationOptions.stallDeadlineMs`, a client-only knob that is stripped
 * before the wire.
 */

/**
 * Floor: catches the zero-events stall class (e.g. the JWT-rotation
 * transport hang) regardless of requested size.
 */
export const GENERATION_STALL_FLOOR_MS = 120_000;

/**
 * Generous per-token silence allowance. ~4k tokens ≈ 300s — continuous with
 * the fixed 300s window this derivation replaced.
 */
export const GENERATION_STALL_MS_PER_TOKEN = 75;

/**
 * When the request omits `maxTokens`, the worker caps output at its own
 * default (`packages/jobs/src/workers/generation/resource-generation.ts`,
 * `DEFAULT_MAX_TOKENS`). The sdk cannot import the jobs package, so the
 * value is mirrored here; drift only mis-sizes the deadline for
 * `maxTokens`-less requests, where the floor dominates anyway.
 */
export const GENERATION_STALL_ASSUMED_MAX_TOKENS = 500;

/** The single derivation site (D1a): floor + per-token scaling. */
export function deriveStallDeadlineMs(maxTokens: number | undefined): number {
  const tokens = maxTokens ?? GENERATION_STALL_ASSUMED_MAX_TOKENS;
  return Math.max(GENERATION_STALL_FLOOR_MS, tokens * GENERATION_STALL_MS_PER_TOKEN);
}

/**
 * Inter-event silence exceeded the deadline. By the time this reaches a
 * consumer the guard has already fired the server-side cancel
 * (`job:cancel-requested`, jobType `generation`). Consumers word their own
 * user-facing message — the SDK ships no copy.
 */
export class GenerationStallError extends SemiontError {
  constructor(
    public readonly deadlineMs: number,
    public readonly jobId: string | null,
  ) {
    super(
      `generation stalled: no event within ${deadlineMs}ms — cancel requested`,
      'generation-stall',
      { deadlineMs, jobId },
    );
    this.name = 'GenerationStallError';
  }
}
