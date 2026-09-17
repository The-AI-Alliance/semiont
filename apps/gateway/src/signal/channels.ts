/**
 * Channel predicates over the GENERATED classification
 * (`CHANNEL_ATTRS`, BUS-ROUTING-DECLARED P1) — consumed, never re-derived.
 *
 * The mapping onto the ledger's vocabulary: the correlated set is every
 * channel delivered `'correlated'` — the result and failure of every
 * registered operation. A `'streaming'` sibling existed for progress frames,
 * which refreshed a claim's TTL without being retained as the answer; its one
 * declared channel was never emitted by anything and was removed 2026-09-17.
 * `replyChannelsFor` remains the runtime roster helper for workers and service
 * rosters; the core classification suite asserts the two projections of the
 * registry agree.
 */
import { CHANNEL_ATTRS, channelAttrsOf } from '@semiont/core';

export const isCorrelatedChannel = (channel: string): boolean =>
  channelAttrsOf(channel)?.delivery === 'correlated';

export const CORRELATED_CHANNELS: readonly string[] =
  Object.keys(CHANNEL_ATTRS).filter(isCorrelatedChannel);
