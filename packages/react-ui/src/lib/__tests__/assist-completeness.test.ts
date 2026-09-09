/**
 * RD4's badge truth table (DETECTION-RESULT-STREAMING P3), exactly four rows —
 * the two sharpenings are the point:
 *
 *   1. Absence only means clean on the TERMINAL surface. Settledness is
 *      established at the state-unit boundary (only terminal shapes enter
 *      `outcome$`), so a null outcome here IS the non-terminal row — mid-run
 *      absence of verdicts must produce NO badge, never "clean".
 *   2. `underReported` is one of TWO partial shapes. A terminal fail carries
 *      no verdict vocabulary at all; it keys off standing annotations, and a
 *      fail with nothing standing is a plain failure (the toast's business),
 *      not a badge.
 *
 * Presence of `underReportedPieces` IS the verdict — the emitting side is
 * mutation-proven never to manufacture a zero, so this function renders the
 * wire's claim and does not second-guess it with a `> 0` re-check.
 */
import { describe, it, expect } from 'vitest';
import { assistCompleteness } from '../assist-completeness';

describe('assistCompleteness — the four rows', () => {
  it('non-terminal → no settled badge', () => {
    expect(assistCompleteness(null, 0)).toBeNull();
    expect(assistCompleteness(null, 7)).toBeNull();
  });

  it('terminal complete, no verdicts → clean', () => {
    expect(assistCompleteness({ kind: 'complete', motivation: 'highlighting' }, 3)).toBe('clean');
  });

  it('terminal complete, verdicts → partial (under-reported)', () => {
    expect(
      assistCompleteness({ kind: 'complete', motivation: 'highlighting', underReportedPieces: 2 }, 3),
    ).toBe('under-reported');
  });

  it('terminal fail with standing annotations → partial (incomplete units)', () => {
    expect(
      assistCompleteness({ kind: 'incomplete', motivation: 'highlighting', completedUnits: ['Person'] }, 4),
    ).toBe('incomplete');
  });

  it('terminal fail with NOTHING standing → no badge; that failure is the toast\'s business', () => {
    expect(assistCompleteness({ kind: 'incomplete', motivation: 'highlighting' }, 0)).toBeNull();
  });
});
