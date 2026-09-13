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
 * No assertion here, and none needed: `WorkerBus` is now typed by channel
 * (WORKER-BUS-TYPED-BY-CHANNEL) and `EventBus.get` already was, so the two
 * agree on their own. The previous version cast twice —
 * `channel as EventName` and `as unknown as Observable<T>` — to bridge a
 * typed bus to an untyped surface, and called the erasure deliberate.
 */

import { BehaviorSubject, type Observable } from 'rxjs';
import type { ConnectionState, EventBus, EventMap } from '@semiont/core';
import type { WorkerBus } from '@semiont/sdk';

export function workerBusOverEventBus(eventBus: EventBus): WorkerBus {
  return {
    stream: <K extends keyof EventMap>(channel: K): Observable<EventMap[K]> =>
      eventBus.get(channel).asObservable(),

    // In-process delivery is synchronous — there is no attach window to
    // lose a reply in, so `'open'` is the true state, not a stub. Post-
    // destroy use is guarded upstream: `eventBus.get()` throws on a
    // destroyed bus before any gate could matter. Published read-only
    // (X1): the subject's mutators must not leak to consumers.
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),

    emit: async <K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<number> => {
      // Two casts gone with the signature: `channel as EventName` and
      // `payload as EventMap[EventName]`. Under one `K` the bus agrees.
      eventBus.get(channel).next(payload);
      // In-process: no subscriber accounting — the ITransport "unknown" sentinel.
      return -1;
    },

    addChannels: () => {
      // No-op: the in-process bus already delivers every emit; channel
      // subscription sets are an SSE-gateway concern.
    },
  };
}
