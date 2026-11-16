/**
 * SmelterActorStateUnit — domain-event fan-in for the Smelter worker.
 *
 * Subscribes to the nine smelter-relevant channels on a shared bus and
 * exposes them as a single typed `events$` stream. Transport-neutral —
 * the caller passes a `WorkerBus` (HTTP `ActorStateUnit` today, an in-process
 * bus shim if/when one exists). The state unit does not own the bus and does
 * not dispose it.
 *
 * `start()` widens the bus's channel-subscription set to include the
 * smelter channels. On HTTP this extends the SSE subscription URL;
 * on an in-process bus this is a no-op (the underlying `EventBus`
 * already delivers every emit).
 */

import { Observable, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import type { WorkerBus } from '@semiont/sdk';
import type { EventMap, StateUnit } from '@semiont/core';

export interface SmelterEvent {
  type: string;
  resourceId?: string;
  payload: Record<string, unknown>;
}

export interface SmelterActorStateUnitOptions {
  bus: WorkerBus;
}

const SMELTER_CHANNELS = [
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

// Commands ride their own stream, never the event mailbox (the
// weave:rebuild idiom): a command handler plans work items and AWAITS
// their drain, so folding it into the per-resource lanes it drains into
// would deadlock a scoped rebuild against its own work.
const SMELTER_COMMAND_CHANNELS = ['smelt:rebuild-anchors'] as const;

export interface SmelterActorStateUnit extends StateUnit {
  events$: Observable<SmelterEvent>;
  /** `smelt:rebuild-anchors` commands (PERSIST-ANCHORS P0) — see the command-channel note above. */
  rebuildAnchors$: Observable<EventMap['smelt:rebuild-anchors']>;
  start(): void;
}

export function createSmelterActorStateUnit(options: SmelterActorStateUnitOptions): SmelterActorStateUnit {
  const { bus } = options;
  let started = false;

  const events$ = merge(
    ...SMELTER_CHANNELS.map((channel) =>
      bus.on$<Record<string, unknown>>(channel).pipe(
        map((payload) => ({
          type: channel,
          resourceId: payload.resourceId as string | undefined,
          payload,
        })),
      ),
    ),
  );

  const rebuildAnchors$ = bus.on$<EventMap['smelt:rebuild-anchors']>('smelt:rebuild-anchors');

  return {
    events$,
    rebuildAnchors$,
    start: () => {
      if (started) return;
      started = true;
      bus.addChannels?.([...SMELTER_CHANNELS, ...SMELTER_COMMAND_CHANNELS]);
    },
    dispose: () => {
      // The bus is owned by the caller; the state unit only releases its own
      // local state, of which there is none beyond the `started` flag.
      started = false;
    },
  };
}
