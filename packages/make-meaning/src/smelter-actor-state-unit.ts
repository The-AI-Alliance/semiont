/**
 * SmelterActorStateUnit — domain-event fan-in for the Smelter worker.
 *
 * Subscribes to the six smelter-relevant channels on a shared bus and
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
import type { StateUnit, WorkerBus } from '@semiont/sdk';

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
  'mark:added',
  'mark:removed',
] as const;

export interface SmelterActorStateUnit extends StateUnit {
  events$: Observable<SmelterEvent>;
  emit(channel: string, payload: Record<string, unknown>): Promise<void>;
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

  return {
    events$,
    emit: (channel, payload) => bus.emit(channel, payload),
    start: () => {
      if (started) return;
      started = true;
      bus.addChannels?.([...SMELTER_CHANNELS]);
    },
    dispose: () => {
      // The bus is owned by the caller; the state unit only releases its own
      // local state, of which there is none beyond the `started` flag.
      started = false;
    },
  };
}
