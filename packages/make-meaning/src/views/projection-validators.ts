/**
 * Projection validators — pure functions that take a projection's
 * current state plus a caller-supplied command input and decide
 * whether the input is valid against the registered vocabulary.
 *
 * Used by the Stower for `mark:update-entity-types`: it reads the
 * projection (I/O), passes it here (pure), and either appends or
 * rejects with the error these functions return.
 *
 * Sibling to the projection-reducers in `@semiont/event-sourcing` —
 * reducers handle the write side of projections; validators handle
 * the read side. Both are I/O-free so the test for "unknown entity
 * type rejects" doesn't need a filesystem or a Stower.
 *
 * Load-bearing properties (mutual exclusion, soundness, completeness,
 * order preservation, no-mutation) are pinned by axiom-style
 * fast-check tests in `__tests__/views/projection-validators.test.ts`.
 * See `docs/system/PROJECTION-PATTERN.md` for the full axiom catalog
 * and the architectural narrative.
 */

// ── Entity types ──────────────────────────────────────────────────────

/**
 * Result of {@link validateEntityTypes}.
 *
 * Two cases — `ok: true` when all supplied tags are in the registered
 * set (or none were supplied at all), `ok: false` plus the offending
 * unknown tags otherwise.
 */
export type ValidateEntityTypesResult =
  | { ok: true }
  | { ok: false; unknown: string[] };

/**
 * Validate that every caller-supplied entity type is in the per-KB
 * entity-type projection.
 *
 * Pure read of `registered` (the unwrapped projection content; what
 * `readEntityTypesProjection` returns). Empty/missing `requested`
 * skips the check entirely — "no tags supplied" is not a validation
 * failure, and the validator should never trigger an unnecessary
 * projection read for it.
 */
export function validateEntityTypes(
  registered: readonly string[],
  requested: readonly string[] | undefined,
): ValidateEntityTypesResult {
  if (!requested || requested.length === 0) {
    return { ok: true };
  }
  const set = new Set(registered);
  const unknown = requested.filter((t) => !set.has(t));
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true };
}

/**
 * The error message for an entity-type validation failure:
 * `Entity type not registered: <comma-list>`, the wording the dispatcher's
 * `job:create` refusal uses too (docs/protocol/JOBS.md).
 */
export function entityTypesNotRegisteredMessage(unknown: readonly string[]): string {
  return `Entity type not registered: ${unknown.join(', ')}`;
}
