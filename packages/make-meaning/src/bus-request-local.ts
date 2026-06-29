import type { Observable } from 'rxjs';
import type { EventBus, EventMap, BusRequestPrimitive } from '@semiont/core';

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
    emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<void> {
      eventBus.get(channel).next(payload);
      return Promise.resolve();
    },
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
      return eventBus.get(channel).asObservable();
    },
  };
}
