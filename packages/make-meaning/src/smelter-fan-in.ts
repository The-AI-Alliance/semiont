/**
 * The Smelter's domain-event fan-in.
 *
 * Merges the nine smelter-relevant channels of a bus into a single typed
 * `events$` stream, with the command channel beside it. Transport-neutral —
 * the caller passes a `BusRequestPrimitive` (the HTTP `ActorStateUnit` in
 * `smelter-main`). Both streams are views of that bus: nothing here is owned,
 * so there is nothing to dispose.
 */

import { Observable, merge } from 'rxjs';
import type { BusRequestPrimitive } from '@semiont/core';
import { SMELTER_REPLY_CHANNELS } from './service-channels';
import type { BusFrame, EventMap } from '@semiont/core';

export const SMELTER_CHANNELS = [
  'yield:created',
  'yield:updated',
  'yield:representation-added',
  'mark:archived',
  'mark:unarchived',
  'mark:added',
  'mark:removed',
  'mark:entity-tag-added',
  'mark:entity-tag-removed',
] as const;

export type SmelterChannel = (typeof SMELTER_CHANNELS)[number];

/**
 * A domain event exactly as the bus delivers it — a full `StoredEvent`, body
 * under `.payload` — passed through verbatim, as the Weaver's fan-in does.
 * Derived from `EventMap`, never re-shaped: an envelope that re-nests the
 * message under its own `payload` field is how a handler once read
 * `event.payload.annotationId` one level too shallow with nothing to object.
 * Every channel above is a resource event, so `resourceId` is required here.
 */
export type SmelterEvent = EventMap[SmelterChannel];

// Commands ride their own stream, never the event mailbox (the
// weave:rebuild idiom): a command handler plans work items and AWAITS
// their drain, so folding it into the per-resource lanes it drains into
// would deadlock a scoped rebuild against its own work.
export const SMELTER_COMMAND_CHANNELS = ['smelt:rebuild-anchors'] as const;

export interface SmelterFanIn {
  events$: Observable<SmelterEvent>;
  /** `smelt:rebuild-anchors` commands, the operator's on-demand rebuild of
   *  anchored-text artifacts — see the command-channel note above. */
  rebuildAnchors$: Observable<BusFrame<EventMap['smelt:rebuild-anchors']>>;
}

/**
 * The Smelter's complete subscription manifest — what `smelter-main`
 * constructs its transport with, stated once.
 *
 * The fan-in asks the bus for its streams the moment it is called, so every
 * channel must be in the set before then: a set widened afterwards leaves a
 * window where consumption outruns declaration, and the transport's `stream`
 * refusal rejects `yield:created` outright (globally bridged, so not
 * scopable either).
 */
export const SMELTER_MANIFEST: readonly (keyof EventMap)[] = [
  ...SMELTER_REPLY_CHANNELS,
  ...SMELTER_CHANNELS,
  ...SMELTER_COMMAND_CHANNELS,
];

export function smelterFanIn(bus: BusRequestPrimitive): SmelterFanIn {
  return {
    events$: merge(...SMELTER_CHANNELS.map((channel) => bus.stream(channel))),
    rebuildAnchors$: bus.frames('smelt:rebuild-anchors'),
  };
}
