/**
 * workerBusOverEventBus — the in-process WorkerBus shim over the core
 * EventBus (WEAVER-ISOLATION P2).
 *
 * `WorkerBus` is the transport seam actor fan-ins consume
 * (`SmelterActorStateUnit`, `WeaverActorStateUnit`): HTTP `ActorStateUnit`
 * in a standalone worker, this shim inside the backend process. The
 * smelter fan-in's doc anticipated exactly this ("an in-process bus shim
 * if/when one exists").
 *
 * The WorkerBus surface is stringly-typed by design — channel names are
 * wire strings on every transport — so the EventMap typing is re-asserted
 * at the consumer boundary (e.g. the fan-in's `on$<StoredEvent>`), not here.
 */

import type { Observable } from 'rxjs';
import type { EventBus, EventMap, EventName } from '@semiont/core';
import type { WorkerBus } from '@semiont/sdk';

export function workerBusOverEventBus(eventBus: EventBus): WorkerBus {
  return {
    on$: <T = Record<string, unknown>>(channel: string): Observable<T> =>
      eventBus.get(channel as EventName) as unknown as Observable<T>,

    emit: async (channel: string, payload: Record<string, unknown>): Promise<void> => {
      eventBus.get(channel as EventName).next(payload as EventMap[EventName]);
    },

    addChannels: () => {
      // No-op: the in-process bus already delivers every emit; channel
      // subscription sets are an SSE-gateway concern.
    },
  };
}
