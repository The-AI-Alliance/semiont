/**
 * Projection validators — pure functions that take a projection's
 * current state plus a caller-supplied command input and decide
 * whether the input is valid against the registered vocabulary.
 *
 * Used by the dispatcher in `handlers/job-commands.ts`. The dispatcher
 * reads the projection (I/O), passes it here (pure), and either
 * resolves the input or rejects with the error these functions return.
 *
 * Sibling to the projection-reducers in `@semiont/event-sourcing` —
 * reducers handle the write side of projections; validators handle
 * the read side. Both are I/O-free so the test for "unknown schemaId
 * rejects" doesn't need a filesystem or a Stower.
 *
 * Load-bearing properties (mutual exclusion, soundness, completeness,
 * order preservation, no-mutation) are pinned by axiom-style
 * fast-check tests in `__tests__/views/projection-validators.test.ts`.
 * See `docs/system/PROJECTION-PATTERN.md` for the full axiom catalog
 * and the architectural narrative.
 */

import type { TagSchema } from '@semiont/core';

// ── Tag schemas ───────────────────────────────────────────────────────

/**
 * Result of {@link resolveTagSchema}.
 *
 * Discriminated union — callers narrow on the absence of `error` to
 * get a typed `TagSchema`.
 */
export type ResolveTagSchemaResult =
  | { schema: TagSchema; error?: undefined }
  | { schema?: undefined; error: string };

/**
 * Look up a tag schema by id in the per-KB tag-schema projection.
 *
 * Pure read of `tagSchemas` (the unwrapped projection content; what
 * `readTagSchemasProjection` returns). Returns either the resolved
 * schema or a caller-facing error message.
 *
 * Two failure modes:
 *  - Empty/missing schemaId → "tag-annotation requires schemaId"
 *  - Non-empty but unregistered → "Tag schema not registered: <id>"
 *
 * Both messages are surfaced verbatim to the bus via `job:create-failed`.
 */
export function resolveTagSchema(
  tagSchemas: readonly TagSchema[],
  schemaId: unknown,
): ResolveTagSchemaResult {
  if (typeof schemaId !== 'string' || !schemaId) {
    return { error: 'tag-annotation requires schemaId' };
  }
  const schema = tagSchemas.find((s) => s.id === schemaId);
  if (!schema) {
    return { error: `Tag schema not registered: ${schemaId}` };
  }
  return { schema };
}

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
 * Format the standard error message for an entity-type validation
 * failure. Kept here so the dispatcher and any future caller agree on
 * the wire format — same `Entity type not registered: <comma-list>`
 * shape that `mark.assist` and `yield.fromAnnotation` callers handle.
 */
export function entityTypesNotRegisteredMessage(unknown: readonly string[]): string {
  return `Entity type not registered: ${unknown.join(', ')}`;
}
