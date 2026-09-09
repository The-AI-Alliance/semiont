import type { MarkAssistOutcome } from '@semiont/sdk';

/** The badge states RD4 permits. There is deliberately no 'unknown'. */
export type AssistCompleteness = 'clean' | 'under-reported' | 'incomplete';

/**
 * RD4's completeness verdict for a settled assist run
 * (DETECTION-RESULT-STREAMING P3). Four rows, nothing else:
 *
 *   outcome null                        → null   (non-terminal: no settled badge)
 *   complete, underReportedPieces absent → 'clean'
 *   complete, underReportedPieces present → 'under-reported'
 *   incomplete + standing annotations    → 'incomplete'
 *   incomplete + nothing standing        → null   (a plain failure — toasted, not badged)
 *
 * Settledness is the state unit's contract: only terminal shapes enter
 * `outcome$` (a retryable fail settles nothing), so this function never sees
 * a mid-run frame and must not be handed one. Absence of `underReportedPieces`
 * is the wire's mutation-proven claim of cleanliness — rendered as clean,
 * never re-derived, never defaulted.
 */
export function assistCompleteness(
  outcome: MarkAssistOutcome | null,
  standingAnnotationCount: number,
): AssistCompleteness | null {
  if (!outcome) return null;
  if (outcome.kind === 'complete') {
    return outcome.underReportedPieces !== undefined ? 'under-reported' : 'clean';
  }
  return standingAnnotationCount > 0 ? 'incomplete' : null;
}
