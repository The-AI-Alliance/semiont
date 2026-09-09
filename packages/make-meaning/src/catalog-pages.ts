/**
 * Paging the resource catalog over the bus — one implementation for both
 * projectors, retried while the service that answers has not connected.
 *
 * The weaver and the smelter each open their repair passes by enumerating every
 * live resource through `browse:resources-requested`, and each had its own
 * identical `for(;;)` loop to do it (`Weaver.fetchAllResources`,
 * `Smelter.listAllResources`). One shape, two homes.
 *
 * **Why the retry lives here and not around the pass.** The failure is a startup
 * race: `browse:*` is answered by the ARCHIVIST, and a weaver that finishes
 * authenticating first asks a channel nobody is subscribed to yet — measured at
 * 3 s into a boot, both passes failing 12 ms apart and giving up for the life of
 * the process (2026-09-09). Retrying the whole pass instead would re-run every
 * page that already succeeded, which is the amplification
 * SIDECAR-BOOT-RESILIENCE D3 rejected in as many words; retrying the PAGE obeys
 * that rule and additionally survives the archivist dropping between page 3 and
 * page 4.
 *
 * **What it costs when it fails anyway.** After the budget, the error propagates
 * exactly as before and `runBootPass` logs and continues — D4 is untouched. This
 * changes *when* that handler is reached, never what it does.
 *
 * Not boot-only, and that is accepted: `weave:rebuild` and
 * `smelt:rebuild-anchors` are operator-triggered and take this path too, so they
 * inherit the same patience. Right for a rebuild that wants to succeed, though it
 * does stretch `STARTUP_FETCH_RETRY`'s name past "startup".
 */

import {
  busRequest,
  isPeerUnavailable,
  retryWithBackoff,
  STARTUP_FETCH_RETRY,
  type BusRequestPrimitive,
  type ResourceDescriptor,
} from '@semiont/core';

/**
 * The one channel this pages.
 *
 * Exported because both projectors DERIVE their `*CatalogPageAwaits` from it.
 * Before this module existed, each held its own literal and tied it to its roster
 * with `satisfies` — two independent strings that happened to match. Collapsing
 * the loops would have quietly dropped that gate; deriving the roster types from
 * the channel actually requested is stronger than restoring it, because now they
 * cannot disagree rather than merely being checked.
 */
export const CATALOG_CHANNEL = 'browse:resources-requested' as const;

export interface CatalogPageOptions {
  /** Page size. The two callers differ here and always have. */
  limit: number;
  /** The smelter excludes archived resources; the weaver projects them too. */
  archived?: boolean;
}

/**
 * Every live resource in the catalog, paged to exhaustion.
 *
 * Each PAGE request retries while the answering service is still connecting;
 * pages already fetched are never re-requested.
 */
export async function fetchCatalogPages(
  bus: BusRequestPrimitive,
  options: CatalogPageOptions,
): Promise<ResourceDescriptor[]> {
  const all: ResourceDescriptor[] = [];
  for (;;) {
    const page = await retryWithBackoff(
      () => busRequest(bus, CATALOG_CHANNEL, {
        ...(options.archived !== undefined ? { archived: options.archived } : {}),
        offset: all.length,
        limit: options.limit,
      }),
      isPeerUnavailable,
      STARTUP_FETCH_RETRY,
    );
    all.push(...page.resources);
    if (page.resources.length === 0 || all.length >= page.total) return all;
  }
}
