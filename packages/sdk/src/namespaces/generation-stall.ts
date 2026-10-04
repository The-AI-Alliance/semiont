import {
  GENERATION_STALL_ASSUMED_TOKENS_COUNT,
  GENERATION_STALL_FLOOR_MS,
  GENERATION_STALL_PER_TOKEN_MS,
  SemiontError,
} from '@semiont/core';
import type { JobErrorCode } from '@semiont/core';

/**
 * The ONE stall guard for generation streams: silence past the deadline
 * cancels the job and raises a typed error, and no consumer of the stream
 * keeps a timer of its own.
 *
 * The generation wire is exactly three frames (5 → 95 → 100), so the 5→95
 * silence spans the entire inference call. The deadline therefore derives
 * from the request's `maxTokens` — never a fixed constant — because the
 * guard CANCELS server-side, and a mis-sized fixed default would destroy
 * the longest legitimate runs. Consumers override per call with
 * `GenerationOptions.stallDeadlineMs`, a client-only knob that is stripped
 * before the wire.
 */

/**
 * The single derivation site: a floor, and a wait that grows with the
 * length asked for. The three numbers are specs/src/client/timing.json's, so
 * every SDK waits as long.
 */
export function deriveStallDeadlineMs(maxTokens: number | undefined): number {
  const tokens = maxTokens ?? GENERATION_STALL_ASSUMED_TOKENS_COUNT;
  return Math.max(GENERATION_STALL_FLOOR_MS, tokens * GENERATION_STALL_PER_TOKEN_MS);
}

/**
 * Inter-event silence exceeded the deadline. By the time this reaches a
 * consumer the guard has already fired the server-side cancel
 * (`job:cancel-requested`, jobType `generation`). Consumers word their own
 * user-facing message — the SDK ships no copy.
 */
export class GenerationStallError extends SemiontError {
  declare code: JobErrorCode;

  constructor(
    public readonly deadlineMs: number,
    public readonly jobId: string | null,
  ) {
    super(
      `generation stalled: no event within ${deadlineMs}ms — cancel requested`,
      'job.stalled' satisfies JobErrorCode,
      { deadlineMs, jobId },
    );
    this.name = 'GenerationStallError';
  }
}
