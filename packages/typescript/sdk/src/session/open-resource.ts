/**
 * OpenResource — a single entry in the open-resources list (tabs) — and the
 * pure list operations over it.
 *
 * The list itself lives on `SemiontBrowser.openResources$`, and the CRUD
 * methods (`addOpenResource`, `removeOpenResource`, `updateOpenResourceName`,
 * `reorderOpenResources`) are its methods. What lives HERE is everything that
 * is a function of a list and nothing else — ordering, and the keep/drop
 * policy for revalidation — so both are testable without constructing a
 * browser.
 *
 * Its stored shape is protocol/specs/src/session/stored.json's `openResource`,
 * held by __tests__/stored-table.test.ts.
 */

import type { ResourceId } from '@semiont/core';

export interface OpenResource {
  /** The resource. */
  id: ResourceId;

  /** The name the resource is shown by. */
  name: string;

  /** When the resource was opened, in milliseconds since the Unix epoch. Opening it again while it is open changes neither this nor its place. */
  openedAt: number;

  /**
   * Its place among those open in the knowledge base, from 0. One opened is
   * given the place after the last taken; a move gives each its place in the
   * new order.
   */
  order: number;

  /** Its media type, which its icon is chosen by. Absent when it is not known. */
  mediaType?: string;

  /** Where it is in the knowledge base's working tree, as a URI (e.g. "file://docs/overview.md"). Absent when it is not known. */
  storageUri?: string;
}

/**
 * What checking one tab against its KB concluded.
 *
 * `gone` is the only verdict that removes, and it means the KB affirmed the
 * resource does not exist — not that the check failed. A transport
 * error, a timeout, an unreachable peer: all `unknown`, and an unknown tab
 * stays. Wiping tabs because a service was briefly down would be strictly
 * worse than the phantoms this exists to remove.
 */
export type TabCheck =
  | { kind: 'gone' }
  | { kind: 'ready'; name: string; mediaType?: string }
  | { kind: 'unknown' };

/**
 * Apply per-tab verdicts to a list: drop the affirmed-absent, refresh what
 * validated, leave everything else exactly as it was.
 *
 * Takes the list as an argument rather than closing over a snapshot, and that
 * is load-bearing: the caller passes the CURRENT committed list, so a tab a
 * sibling context added while the checks were in flight survives — it simply
 * has no verdict, and no verdict means no change.
 */
export function applyTabChecks(
  list: readonly OpenResource[],
  checks: ReadonlyMap<ResourceId, TabCheck>,
): OpenResource[] {
  const kept: OpenResource[] = [];
  for (const tab of list) {
    const check = checks.get(tab.id);
    if (check?.kind === 'gone') continue;
    if (check?.kind === 'ready') {
      // The pass that proves a tab real also refreshes what it displays,
      // so a renamed resource stops showing its name from whenever the tab
      // was opened. Free — the descriptor is already in hand.
      kept.push({
        ...tab,
        name: check.name,
        ...(check.mediaType ? { mediaType: check.mediaType } : {}),
      });
      continue;
    }
    kept.push(tab);
  }
  return kept;
}

/** By place, and two in one place by when each was opened, earliest first. */
export function sortOpenResources(resources: OpenResource[]): OpenResource[] {
  return [...resources].sort((a, b) => (a.order === b.order ? a.openedAt - b.openedAt : a.order - b.order));
}
