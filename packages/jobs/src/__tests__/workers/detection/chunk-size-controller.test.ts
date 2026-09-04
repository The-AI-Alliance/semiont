/**
 * Adaptive chunk sizing (DETECTION-QUALITY-THROUGHPUT P2) — controller unit
 * tests. The plan's RED: grows on sparse output, backs off on dense/truncated,
 * never leaves [floor, ceiling], tracks a gradient rather than betting the run
 * on the first sample.
 *
 * The controller steers ONE number — output utilization — and leans on
 * subdivision for the hard bounds, so these are all about that one steer.
 */

import { describe, it, expect } from 'vitest';
import {
  nextChunkSize,
  DEFAULT_CHUNK_SIZING_POLICY,
  type SizingBounds,
} from '../../../workers/detection/chunk-size-controller';

// A window with room above the static starting size, so "grow" has somewhere
// to go — the window-fit ceiling, distinct from the derived starting budget.
const BOUNDS: SizingBounds = { floor: 96, ceiling: 40_000, outputBudget: 10_666 };

describe('nextChunkSize', () => {
  it('grows when the last chunk left budget on the table — the calibration case', () => {
    // The live run: output 4,117 of a 10,666 budget = 39%, under growBelow(0.5).
    const next = nextChunkSize({ outputTokens: 4_117, truncated: false }, 5_333, BOUNDS);
    expect(next).toBe(Math.floor(5_333 * DEFAULT_CHUNK_SIZING_POLICY.growFactor)); // 7,999
  });

  it('eases off when output nears the budget — before it truncates', () => {
    // 92% of budget: over shrinkAbove(0.8), so ease down rather than wait for
    // the next stretch to spill over.
    const next = nextChunkSize({ outputTokens: 9_800, truncated: false }, 6_000, BOUNDS);
    expect(next).toBe(Math.floor(6_000 * DEFAULT_CHUNK_SIZING_POLICY.shrinkFactor)); // 4,200
  });

  it('holds inside the band — neither starving nor near the edge', () => {
    // 65% of budget: between growBelow and shrinkAbove.
    const next = nextChunkSize({ outputTokens: 6_900, truncated: false }, 6_000, BOUNDS);
    expect(next).toBe(6_000);
  });

  it('shrinks on a truncation regardless of the reported count', () => {
    // Subdivision is already halving-and-retrying THIS chunk; the sizer pulls
    // the NEXT one down too so the run rides the density change, not one piece.
    const next = nextChunkSize({ outputTokens: 0, truncated: true }, 8_000, BOUNDS);
    expect(next).toBe(Math.floor(8_000 * DEFAULT_CHUNK_SIZING_POLICY.shrinkFactor)); // 5,600
  });

  it('never proposes above the ceiling, however much room a chunk shows', () => {
    const next = nextChunkSize({ outputTokens: 10, truncated: false }, 30_000, BOUNDS);
    expect(next).toBeLessThanOrEqual(BOUNDS.ceiling);
  });

  it('never proposes below the floor, however dense', () => {
    const next = nextChunkSize({ outputTokens: 10_666, truncated: true }, 120, BOUNDS);
    expect(next).toBeGreaterThanOrEqual(BOUNDS.floor);
  });

  it('tracks a gradient: grows through a sparse run, then pulls back as it densifies', () => {
    // Sparse intro, then a dense index — the case that breaks a size-once
    // scheme. The sizer must climb on the sparse stretch, then reverse when
    // utilization crosses the band, not ride a stale first sample into a wall
    // of truncations.
    const afterGrow = nextChunkSize({ outputTokens: 3_000, truncated: false }, 5_333, BOUNDS); // 28% → grow
    const afterDense = nextChunkSize({ outputTokens: 10_100, truncated: false }, afterGrow, BOUNDS); // 95% → shrink
    expect(afterGrow).toBeGreaterThan(5_333);
    expect(afterDense).toBeLessThan(afterGrow);
  });

  it('respects a caller-supplied policy — the future tunable surface', () => {
    // Aggressive policy: same 39% outcome, but growFactor 3 instead of 1.5.
    const aggressive = { growBelow: 0.5, shrinkAbove: 0.8, growFactor: 3, shrinkFactor: 0.5 };
    const next = nextChunkSize({ outputTokens: 4_117, truncated: false }, 5_333, BOUNDS, aggressive);
    expect(next).toBe(Math.floor(5_333 * 3)); // 15,999 — the policy governed, not the default
  });

  it('holds on a degenerate (zero) budget rather than dividing by zero', () => {
    const next = nextChunkSize({ outputTokens: 0, truncated: false }, 6_000, { ...BOUNDS, outputBudget: 0 });
    expect(next).toBe(6_000);
  });
});
