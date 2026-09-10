/**
 * Every resource, paged over the bus. Shared by the weaver and the smelter,
 * which had identical loops.
 *
 * The archivist answers `browse:*`, and a projector that authenticates first can
 * ask before it has subscribed. Retried per PAGE, not per boot pass: a pass
 * retry re-sends every page that already succeeded.
 */

import {
  busRequest,
  isPeerUnavailable,
  retryWithBackoff,
  type BusRequestPrimitive,
  type ResourceDescriptor,
  type RetryPolicy,
} from '@semiont/core';

/**
 * How long a projector waits for the archivist to subscribe.
 *
 * Not `STARTUP_FETCH_RETRY` (~39s): that is sized for the gateway, and the
 * archivist's own boot now runs to ~339s worst case — its auth retry plus its
 * embedding-provider retry. Sized by that relationship and gated in
 * `browse-resources.test.ts`, not chosen.
 */
export const RESOURCE_LISTING_RETRY: RetryPolicy = {
  attempts: 17,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/** Exported so both projectors derive their `*CatalogPageAwaits` from the
 *  channel actually requested, rather than repeating the literal. */
export const RESOURCES_CHANNEL = 'browse:resources-requested' as const;

export interface BrowseResourcesOptions {
  limit: number;
  /** The smelter excludes archived resources; the weaver projects them too. */
  archived?: boolean;
}

export async function browseAllResources(
  bus: BusRequestPrimitive,
  options: BrowseResourcesOptions,
): Promise<ResourceDescriptor[]> {
  const all: ResourceDescriptor[] = [];
  for (;;) {
    const page = await retryWithBackoff(
      () => busRequest(bus, RESOURCES_CHANNEL, {
        ...(options.archived !== undefined ? { archived: options.archived } : {}),
        offset: all.length,
        limit: options.limit,
      }),
      isPeerUnavailable,
      RESOURCE_LISTING_RETRY,
    );
    all.push(...page.resources);
    if (page.resources.length === 0 || all.length >= page.total) return all;
  }
}
