/**
 * WeaverActorStateUnit — domain-event fan-in for the Weaver
 * (WEAVER-ISOLATION P2).
 *
 * Subscribes to the nine graph-relevant channels on a shared bus and
 * exposes them as a single `StoredEvent`-typed `events$` stream.
 * Transport-neutral — the caller passes a `BusRequestPrimitive` (the HTTP
 * `ActorStateUnit` in `weaver-main`, the in-process `asBusRequestPrimitive`
 * adapter elsewhere). The state unit does not own the bus and does not
 * dispose it.
 */

import { Observable, merge } from 'rxjs';
import type { BusRequestPrimitive } from '@semiont/core';
import { WEAVER_REPLY_CHANNELS } from './service-channels';
import type { BusFrame, EventMap, StateUnit, StoredEvent } from '@semiont/core';

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

export interface WeaverActorStateUnitOptions {
  bus: BusRequestPrimitive;
}

export interface WeaverActorStateUnit extends StateUnit {
  events$: Observable<StoredEvent>;
  /** `weave:rebuild` commands (WEAVER-ISOLATION D3) — never mixed into the fold. */
  rebuilds$: Observable<BusFrame<EventMap['weave:rebuild']>>;
}

/**
 * The Weaver's complete subscription manifest — what `weaver-main`
 * constructs its transport with, stated once. See SMELTER_MANIFEST for why
 * the whole set must exist before this unit is constructed.
 */
export const WEAVER_MANIFEST: readonly (keyof EventMap)[] = [
  ...WEAVER_REPLY_CHANNELS,
  ...WEAVER_CHANNELS,
  ...WEAVER_COMMAND_CHANNELS,
];

export function createWeaverActorStateUnit(options: WeaverActorStateUnitOptions): WeaverActorStateUnit {
  const { bus } = options;

  // Domain channels carry full `StoredEvent`s on every transport —
  // in-process Subjects and the SSE gateway alike (EVENT-BUS.md, payload
  // categories) — so the fan-in passes them through verbatim: the Weaver's
  // fold needs payload AND storage metadata (sequence numbers feed
  // `lastProcessed` / `weave:applied`).
  const events$ = merge(
    ...WEAVER_CHANNELS.map((channel) => bus.stream(channel)),
  );

  const rebuilds$ = bus.frames('weave:rebuild');

  return {
    events$,
    rebuilds$,
    dispose: () => {
      // The bus is owned by the caller and both streams are derived from it,
      // so this unit holds nothing of its own to release.
    },
  };
}
