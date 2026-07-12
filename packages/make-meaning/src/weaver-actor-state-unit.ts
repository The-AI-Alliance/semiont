/**
 * WeaverActorStateUnit — domain-event fan-in for the Weaver
 * (WEAVER-ISOLATION P2).
 *
 * Subscribes to the nine graph-relevant channels on a shared bus and
 * exposes them as a single `StoredEvent`-typed `events$` stream.
 * Transport-neutral — the caller passes a `WorkerBus` (the in-process
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
import type { WorkerBus } from '@semiont/sdk';
import type { StateUnit, StoredEvent } from '@semiont/core';

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

export interface WeaverActorStateUnitOptions {
  bus: WorkerBus;
}

export interface WeaverActorStateUnit extends StateUnit {
  events$: Observable<StoredEvent>;
  start(): void;
}

export function createWeaverActorStateUnit(options: WeaverActorStateUnitOptions): WeaverActorStateUnit {
  const { bus } = options;
  let started = false;

  // Domain channels carry full `StoredEvent`s on every transport —
  // in-process Subjects and the SSE gateway alike (EVENT-BUS.md, payload
  // categories) — so the fan-in passes them through verbatim: the Weaver's
  // fold needs payload AND storage metadata (sequence numbers feed
  // `lastProcessed` / `weave:applied`).
  const events$ = merge(
    ...WEAVER_CHANNELS.map((channel) => bus.on$<StoredEvent>(channel)),
  );

  return {
    events$,
    start: () => {
      if (started) return;
      started = true;
      bus.addChannels?.([...WEAVER_CHANNELS]);
    },
    dispose: () => {
      // The bus is owned by the caller; the state unit only releases its own
      // local state, of which there is none beyond the `started` flag.
      started = false;
    },
  };
}
