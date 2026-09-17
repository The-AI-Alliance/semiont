/**
 * WeaverActorStateUnit — domain-event fan-in for the Weaver
 * (WEAVER-ISOLATION P2).
 *
 * Subscribes to the nine graph-relevant channels on a shared bus and
 * exposes them as a single `StoredEvent`-typed `events$` stream.
 * Transport-neutral — the caller passes a `BusRequestPrimitive` (the in-process
 * `workerBusOverEventBus` shim today, the HTTP `ActorStateUnit` once the
 * Weaver runs standalone). The state unit does not own the bus and does
 * not dispose it.
 *
 * `start()` widens the bus's channel-subscription set to include the
 * weaver channels. On HTTP this extends the SSE subscription URL; on the
 * in-process shim it is a no-op (the underlying `EventBus` already
 * delivers every emit).
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
  start(): void;
}

/**
 * The Weaver's complete subscription manifest — what `weaver-main`
 * constructs its transport with, stated once. See SMELTER_MANIFEST for why
 * the whole set must exist before construction rather than after `start()`.
 */
export const WEAVER_MANIFEST: readonly (keyof EventMap)[] = [
  ...WEAVER_REPLY_CHANNELS,
  ...WEAVER_CHANNELS,
  ...WEAVER_COMMAND_CHANNELS,
];

export function createWeaverActorStateUnit(options: WeaverActorStateUnitOptions): WeaverActorStateUnit {
  const { bus } = options;
  let started = false;

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
    start: () => {
      if (started) return;
      started = true;
    },
    dispose: () => {
      // The bus is owned by the caller; the state unit only releases its own
      // local state, of which there is none beyond the `started` flag.
      started = false;
    },
  };
}
