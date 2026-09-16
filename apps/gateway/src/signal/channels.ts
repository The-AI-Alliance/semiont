/**
 * Channel predicates over the GENERATED classification
 * (`CHANNEL_ATTRS`, BUS-ROUTING-DECLARED P1) — consumed, never re-derived.
 *
 * The mapping onto the ledger's vocabulary: the correlated set is every
 * channel delivered `'correlated'` OR `'streaming'` (result, failure and
 * progress of every registered operation — progress frames refresh a claim's
 * TTL but are never retained; a stream is not an answer). `replyChannelsFor`
 * remains the runtime roster helper for workers and service rosters; the
 * core classification suite asserts the two projections of the registry
 * agree.
 */
import { CHANNEL_ATTRS, channelAttrsOf } from '@semiont/core';

export const isCorrelatedChannel = (channel: string): boolean => {
  const d = channelAttrsOf(channel)?.delivery;
  return d === 'correlated' || d === 'streaming';
};

export const isProgressChannel = (channel: string): boolean =>
  channelAttrsOf(channel)?.delivery === 'streaming';

export const CORRELATED_CHANNELS: readonly string[] =
  Object.keys(CHANNEL_ATTRS).filter(isCorrelatedChannel);
