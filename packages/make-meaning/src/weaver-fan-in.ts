/**
 * The Weaver's domain-event fan-in.
 *
 * Merges the nine graph-relevant channels of a bus into a single
 * `StoredEvent`-typed `events$` stream, with the command channel beside it.
 * Transport-neutral — the caller passes a `BusRequestPrimitive` (the HTTP
 * `ActorStateUnit` in `weaver-main`, the in-process `asBusRequestPrimitive`
 * adapter elsewhere). Both streams are views of that bus: nothing here is
 * owned, so there is nothing to dispose.
 */

import { Observable, merge } from 'rxjs';
import type { BusRequestPrimitive } from '@semiont/core';
import { WEAVER_REPLY_CHANNELS } from './service-channels';
import type { BusFrame, EventMap, StoredEvent } from '@semiont/core';

export const WEAVER_CHANNELS = [
  'yield:created',
  'mark:archived',
  'mark:unarchived',
  'mark:added',
  'mark:removed',
  'mark:body-updated',
  'mark:entity-tag-added',
  'mark:entity-tag-removed',
  'frame:entity-type-added',
] as const;

/** Commands addressed to the Weaver actor — separate from the domain-event fold. */
export const WEAVER_COMMAND_CHANNELS = ['weave:rebuild'] as const;

export interface WeaverFanIn {
  events$: Observable<StoredEvent>;
  /** `weave:rebuild` commands — never mixed into the fold. */
  rebuilds$: Observable<BusFrame<EventMap['weave:rebuild']>>;
}

/**
 * The Weaver's complete subscription manifest — what `weaver-main`
 * constructs its transport with, stated once. See SMELTER_MANIFEST for why
 * the whole set must exist before the fan-in is called.
 */
export const WEAVER_MANIFEST: readonly (keyof EventMap)[] = [
  ...WEAVER_REPLY_CHANNELS,
  ...WEAVER_CHANNELS,
  ...WEAVER_COMMAND_CHANNELS,
];

export function weaverFanIn(bus: BusRequestPrimitive): WeaverFanIn {
  return {
    // Domain channels carry full `StoredEvent`s on every transport —
    // in-process Subjects and the SSE gateway alike (EVENT-BUS.md, payload
    // categories) — so the fan-in passes them through verbatim: the Weaver's
    // fold needs payload AND storage metadata (sequence numbers feed
    // `lastProcessed` / `weave:applied`).
    events$: merge(...WEAVER_CHANNELS.map((channel) => bus.stream(channel))),
    rebuilds$: bus.frames('weave:rebuild'),
  };
}
