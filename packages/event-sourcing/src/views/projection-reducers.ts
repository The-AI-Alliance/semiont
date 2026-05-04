/**
 * Projection reducers — the pure core of the system-level projection
 * materializers in `view-materializer.ts`.
 *
 * Each reducer takes the current state of a `__system__` projection and
 * a single command payload, and returns the next state plus any
 * side-effect signals (currently just optional warnings). The
 * surrounding I/O — read JSON file → reduce → write JSON file — lives
 * in the `ViewMaterializer` shell.
 *
 * Why this split: tests for the projection-update semantics shouldn't
 * need the filesystem or an Apple-container event store to assert
 * "registering identical content twice is a no-op." The shell is
 * already covered by integration tests at `tag-schemas-reader.test.ts`
 * (Stower → materializer → reader round-trip) and
 * `local-transport.test.ts` (real client → bus → cache invalidation).
 *
 * The reducers also become the natural home for the deferred schema-
 * evolution work in `.plans/EVOLVE-TAG-SCHEMA.md` — migration
 * commands (rename/remove a category, version-bump a schema id) are
 * additional pure functions on the same view shapes.
 */

import type { TagSchema } from '@semiont/core';

// ── Entity types ──────────────────────────────────────────────────────

/**
 * Apply a `frame:entity-type-added` event to the entity-types
 * projection. Idempotent — the existing materializer ensures dedup via
 * a `Set` and stable ordering via a sort; this preserves both.
 */
export function applyEntityTypeAdded(
  current: readonly string[],
  add: string,
): string[] {
  const set = new Set(current);
  set.add(add);
  return Array.from(set).sort();
}

// ── Tag schemas ───────────────────────────────────────────────────────

/**
 * Result of {@link applyTagSchemaAdded}.
 *
 * The reducer is pure — it doesn't log warnings itself. Instead it
 * returns the would-be warning as data; the I/O shell decides whether
 * to forward it to the logger. This keeps the function trivially
 * testable and lets callers compose multiple reductions without
 * threading a logger through.
 */
export interface ApplyTagSchemaAddedResult {
  /** The next state of the tagSchemas list, sorted by id. */
  next: TagSchema[];
  /**
   * Set when an existing schema with the same id was overwritten with
   * differing content (deep-not-equal). Identical re-registrations
   * return `undefined` here — the projection silently no-ops.
   */
  warning?: { schemaId: string; message: string };
}

/**
 * Apply a `frame:tag-schema-added` event to the tag-schemas projection.
 *
 * Most-recent-wins by `schema.id`:
 *  - new id → append + sort
 *  - existing id with identical content → no-op (warning undefined)
 *  - existing id with differing content → replace + warning emitted
 */
export function applyTagSchemaAdded(
  current: readonly TagSchema[],
  add: TagSchema,
): ApplyTagSchemaAddedResult {
  const existingIdx = current.findIndex((s) => s.id === add.id);
  let warning: ApplyTagSchemaAddedResult['warning'];

  let next: TagSchema[];
  if (existingIdx >= 0) {
    const existing = current[existingIdx]!;
    if (!sameSchema(existing, add)) {
      warning = {
        schemaId: add.id,
        message: `tag schema "${add.id}" overwritten — definition changed`,
      };
    }
    next = current.slice();
    next[existingIdx] = add;
  } else {
    next = [...current, add];
  }

  next.sort((a, b) => a.id.localeCompare(b.id));
  return warning ? { next, warning } : { next };
}

/**
 * Structural equality on TagSchema content. JSON.stringify is enough
 * because TagSchema is plain data (string fields, arrays of plain
 * objects with string fields, no nested non-deterministic shapes).
 * If the schema shape ever grows non-deterministic ordering inside
 * categories, this will need a deep-equal that sorts category keys.
 */
function sameSchema(a: TagSchema, b: TagSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
