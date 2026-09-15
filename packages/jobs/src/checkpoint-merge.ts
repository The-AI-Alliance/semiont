import type { UnitCursor } from '@semiont/core';

/**
 * Merge per-unit cursors monotonically (CHUNK-GRAIN-RESUME P2).
 *
 * `completedUnits` is a set, so unioning it converges under concurrent
 * snapshots for free — a set only grows. A cursor has no such property: two
 * checkpoints can be in flight at once and the OLDER one can land last, so a
 * last-writer-wins would drag the resume position backward and the retry would
 * re-pay for chunks it already committed. Keeping the furthest `next` per unit
 * is what makes the merge order-independent.
 *
 * `next` and `size` move together because they are ONE observation of one
 * chunk. Taking the furthest `next` from one snapshot and the `size` from
 * another would describe a chunk that was never cut.
 *
 * A unit in `completed` has no cursor at all: "in progress, here" and
 * "finished" are then structurally exclusive rather than a rule each reader has
 * to remember, and a stale snapshot cannot resurrect a finished unit's cursor.
 *
 * ONE module, shared by every driver (JOB-QUEUE-DRIVER P0): the interface
 * states this rule, and two copies of it would be two chances to disagree
 * about the one property that makes a cursor safe to merge at all.
 */
export function mergeUnitCursors(
  existing: Record<string, UnitCursor> | undefined,
  incoming: Record<string, UnitCursor> | undefined,
  completed: string[],
): Record<string, UnitCursor> {
  const done = new Set(completed);
  const merged: Record<string, UnitCursor> = {};
  for (const [unit, cursor] of Object.entries({ ...existing })) {
    if (!done.has(unit)) merged[unit] = cursor;
  }
  for (const [unit, cursor] of Object.entries({ ...incoming })) {
    if (done.has(unit)) continue;
    const held = merged[unit];
    if (!held || cursor.next > held.next) merged[unit] = cursor;
  }
  return merged;
}
