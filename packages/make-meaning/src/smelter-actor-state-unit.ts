/**
 * SmelterActorStateUnit — domain-event fan-in for the Smelter worker.
 *
 * Subscribes to the nine smelter-relevant channels on a shared bus and
 * exposes them as a single typed `events$` stream. Transport-neutral —
 * the caller passes a `BusRequestPrimitive` (HTTP `ActorStateUnit` today, an in-process
 * bus shim if/when one exists). The state unit does not own the bus and does
 * not dispose it.
 */

import { Observable, merge } from 'rxjs';
import type { BusRequestPrimitive } from '@semiont/core';
import { SMELTER_REPLY_CHANNELS } from './service-channels';
import type { BusFrame, EventMap, StateUnit } from '@semiont/core';

export interface SmelterActorStateUnitOptions {
  bus: BusRequestPrimitive;
}

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

export interface SmelterActorStateUnit extends StateUnit {
  events$: Observable<SmelterEvent>;
  /** `smelt:rebuild-anchors` commands (PERSIST-ANCHORS P0) — see the command-channel note above. */
  rebuildAnchors$: Observable<BusFrame<EventMap['smelt:rebuild-anchors']>>;
}

/**
 * The Smelter's complete subscription manifest — what `smelter-main`
 * constructs its transport with, stated once.
 *
 * The fold's streams are built AT CONSTRUCTION, so every channel must be in
 * the set before this unit exists: a set widened afterwards leaves a window
 * where consumption outruns declaration, and the transport's `stream`
 * refusal rejects `yield:created` outright (globally bridged, so not
 * scopable either).
 */
export const SMELTER_MANIFEST: readonly (keyof EventMap)[] = [
  ...SMELTER_REPLY_CHANNELS,
  ...SMELTER_CHANNELS,
  ...SMELTER_COMMAND_CHANNELS,
];

export function createSmelterActorStateUnit(options: SmelterActorStateUnitOptions): SmelterActorStateUnit {
  const { bus } = options;

  const events$ = merge(
    ...SMELTER_CHANNELS.map((channel) => bus.stream(channel)),
  );

  const rebuildAnchors$ = bus.frames('smelt:rebuild-anchors');

  return {
    events$,
    rebuildAnchors$,
    dispose: () => {
      // The bus is owned by the caller and both streams are derived from it,
      // so this unit holds nothing of its own to release.
    },
  };
}
