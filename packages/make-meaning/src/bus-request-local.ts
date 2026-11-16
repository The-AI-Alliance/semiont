import { BehaviorSubject, type Observable } from 'rxjs';
import type { ConnectionState, EventBus, EventMap, BusRequestPrimitive } from '@semiont/core';

/**
 * Adapt a raw in-process `EventBus` to the `BusRequestPrimitive` that
 * `busRequest` consumes. Lets backend-internal callers (bootstrap, event
 * replay, linked-data import) use the same confirmed request/reply path as the
 * SDK — `busRequest(asBusRequestPrimitive(eventBus), …)` — instead of
 * hand-rolled `race(domain-event, *-failed, timeout)` blocks. The reply is
 * matched by `correlationId`, so concurrent in-process writes can't cross-match
 * (the latent bug in the old domain-event `race`).
 */
export function asBusRequestPrimitive(eventBus: EventBus): BusRequestPrimitive {
  return {
    emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<number> {
      eventBus.get(channel).next(payload);
      // In-process: no subscriber accounting — the ITransport "unknown" sentinel.
      return Promise.resolve(-1);
    },
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
      return eventBus.get(channel).asObservable();
    },
    // In-process delivery is synchronous — no attach window, so `'open'` is
    // the true state (.plans/BUS-ATTACH-GATE.md). A destroyed bus throws at
    // `eventBus.get()` before the gate could matter. Published read-only
    // (X1): the subject's mutators must not leak to consumers.
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
  };
}
