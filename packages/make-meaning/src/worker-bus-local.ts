/**
 * workerBusOverEventBus — the in-process WorkerBus shim over the core
 * EventBus (WEAVER-ISOLATION P2).
 *
 * `WorkerBus` is the transport seam actor fan-ins consume
 * (`SmelterActorStateUnit`, `WeaverActorStateUnit`): HTTP `ActorStateUnit`
 * in a standalone worker, this shim inside the gateway process. The
 * smelter fan-in's doc anticipated exactly this ("an in-process bus shim
 * if/when one exists").
 *
 * The WorkerBus surface is stringly-typed by design — channel names are
 * wire strings on every transport — so the EventMap typing is re-asserted
 * at the consumer boundary (e.g. the fan-in's `on$<StoredEvent>`), not here.
 */

import { BehaviorSubject, type Observable } from 'rxjs';
import type { ConnectionState, EventBus, EventMap, EventName } from '@semiont/core';
import type { WorkerBus } from '@semiont/sdk';

export function workerBusOverEventBus(eventBus: EventBus): WorkerBus {
  return {
    on$: <T = Record<string, unknown>>(channel: string): Observable<T> =>
      eventBus.get(channel as EventName) as unknown as Observable<T>,

    // In-process delivery is synchronous — there is no attach window to
    // lose a reply in, so `'open'` is the true state, not a stub. Post-
    // destroy use is guarded upstream: `eventBus.get()` throws on a
    // destroyed bus before any gate could matter. Published read-only
    // (X1): the subject's mutators must not leak to consumers.
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),

    emit: async (channel: string, payload: Record<string, unknown>): Promise<number> => {
      eventBus.get(channel as EventName).next(payload as EventMap[EventName]);
      // In-process: no subscriber accounting — the ITransport "unknown" sentinel.
      return -1;
    },

    addChannels: () => {
      // No-op: the in-process bus already delivers every emit; channel
      // subscription sets are an SSE-gateway concern.
    },
  };
}
