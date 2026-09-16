/**
 * workerBusOverEventBus — the in-process BusRequestPrimitive shim over the core
 * EventBus (WEAVER-ISOLATION P2).
 *
 * `BusRequestPrimitive` is the transport seam actor fan-ins consume
 * (`SmelterActorStateUnit`, `WeaverActorStateUnit`): HTTP `ActorStateUnit`
 * in a standalone worker, this shim inside the gateway process. The
 * smelter fan-in's doc anticipated exactly this ("an in-process bus shim
 * if/when one exists").
 *
 * No assertion here, and none needed: `BusRequestPrimitive` is now typed by channel
 * (WORKER-BUS-TYPED-BY-CHANNEL) and `EventBus.get` already was, so the two
 * agree on their own. The previous version cast twice —
 * `channel as EventName` and `as unknown as Observable<T>` — to bridge a
 * typed bus to an untyped surface, and called the erasure deliberate.
 */

import { BehaviorSubject, type Observable } from 'rxjs';
import type { ConnectionState, EventBus, EventMap } from '@semiont/core';
import type { BusRequestPrimitive } from '@semiont/core';

export function workerBusOverEventBus(eventBus: EventBus): BusRequestPrimitive {
  return {
    stream: <K extends keyof EventMap>(channel: K): Observable<EventMap[K]> =>
      eventBus.get(channel).asObservable(),

    // Every channel: this bus delivers every emit, so nothing can be outside
    // its receive path. The true answer, not a stub — which is why the member
    // is required rather than omitted.
    isSubscribed: () => true,

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
  };
}
