/**
 * OpenResource — a single entry in the open-resources list (tabs) — and the
 * pure list operations over it.
 *
 * The list itself lives on `SemiontBrowser.openResources$`, and the CRUD
 * methods (`addOpenResource`, `removeOpenResource`, `updateOpenResourceName`,
 * `reorderOpenResources`) are its methods. What lives HERE is everything that
 * is a function of a list and nothing else — ordering, and the keep/drop
 * policy for revalidation — so both are testable without constructing a
 * browser (TABS-REVALIDATE-ON-RESTORE D9).
 */

export interface OpenResource {
  /** Unique identifier for the resource */
  id: string;

  /** Display name of the resource */
  name: string;

  /** Timestamp when the resource was opened */
  openedAt: number;

  /** Order/position for manual sorting (optional for backward compatibility) */
  order?: number;

  /** Media type for icon display (e.g., 'application/pdf', 'text/plain') */
  mediaType?: string;

  /** Working-tree URI (e.g. "file://docs/overview.md") — used as tooltip in navigation */
  storageUri?: string;
}

/**
 * What checking one tab against its KB concluded.
 *
 * `gone` is the only verdict that removes, and it means the KB affirmed the
 * resource does not exist — not that the check failed (D2). A transport
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
 * has no verdict, and no verdict means no change (D11).
 */
export function applyTabChecks(
  list: readonly OpenResource[],
  checks: ReadonlyMap<string, TabCheck>,
): OpenResource[] {
  const kept: OpenResource[] = [];
  for (const tab of list) {
    const check = checks.get(tab.id);
    if (check?.kind === 'gone') continue;
    if (check?.kind === 'ready') {
      // D3: the pass that proves a tab real also refreshes what it displays,
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

/**
 * Manual order where both entries have one, open time otherwise.
 *
 * Moved verbatim from `semiont-browser.ts` (D9) — a pure list operation
 * belongs beside the other one. No behaviour change: `order` is optional for
 * backward compatibility, and a mixed list still falls back to `openedAt`.
 */
export function sortOpenResources(resources: OpenResource[]): OpenResource[] {
  return [...resources].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    return a.openedAt - b.openedAt;
  });
}
