/**
 * The Librarian's bus channel rosters.
 *
 * Its transport subscribes exactly what it consumes, never the full
 * `BRIDGED_CHANNELS`: a transport subscribed to the full set receives and
 * parses every broadcast frame on channels its service never reads, only to
 * drop it. (Replies are not broadcast — the gateway delivers a reply only to
 * its requester: docs/protocol/TRANSPORT-CONTRACT.md.)
 *
 * The Librarian answers operations and awaits none, so its transport carries
 * its inbound roster and no reply channel. What it reads of another service
 * it reads over HTTP: bytes from the Archivist, and a resource's anchored
 * text from the gateway. `busRequest`'s `isSubscribed` probe is the runtime
 * backstop for an await in the Librarian: its transport delivers no reply,
 * so the request is refused at once as `bus.unsubscribed`.
 */

import { replyChannelsFor, type EventMap } from '@semiont/core';

/**
 * The request channels Matcher subscribes to — the Librarian's inbound wire
 * roster for this actor. Pinned to `initialize()`'s actual subscriptions by
 * the census gate in librarian-decoupling.test.ts.
 */
export const MATCHER_CHANNELS = [
  'match:search-requested',
  'match:limits-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The request channels Gatherer subscribes to — the Librarian's inbound wire
 * roster for this actor. Pinned to `initialize()`'s actual subscriptions by
 * the census gate in gatherer-decoupling.test.ts.
 */
export const GATHERER_CHANNELS = [
  'gather:requested',
  'gather:resource-requested',
  'gather:limits-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The request channels the retrieval handlers subscribe, spread into the
 * Librarian's inbound roster; the census gate in resource-retrieval.test.ts
 * pins it to their subscriptions.
 */
export const RETRIEVAL_HANDLER_CHANNELS = [
  'match:resources-requested',
  'gather:referenced-by-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The actors' rosters and the retrieval handlers' (each pinned to its real
 * subscriptions by a census gate), the gather-summary handler's channel, and the two progress
 * SIGNALS the local folds consume (`weave:applied` for the graph grace,
 * `smelt:settled` for the settle barrier). Signals have no BUS_OPERATIONS
 * entries, so the outbound derivation ignores them and nothing echoes. The
 * Librarian's transport subscribes exactly this set: it awaits no reply
 * over the bus.
 */
export const LIBRARIAN_INBOUND_CHANNELS = [
  ...MATCHER_CHANNELS,
  ...GATHERER_CHANNELS,
  ...RETRIEVAL_HANDLER_CHANNELS,
  'gather:summary-requested',
  'weave:applied',
  'smelt:settled',
] as const satisfies readonly (keyof EventMap)[];

/** Every reply channel the Librarian's outbound pump forwards — derived over the inbound set. */
export const LIBRARIAN_OUTBOUND_CHANNELS: readonly (keyof EventMap)[] =
  replyChannelsFor(LIBRARIAN_INBOUND_CHANNELS);
