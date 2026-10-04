import { BehaviorSubject, type Observable } from 'rxjs';
import type { BusEnvelope, ConnectionState, EventBus, EventMap, BusRequestPrimitive } from '@semiont/core';

/**
 * Adapt a raw in-process `EventBus` to `BusRequestPrimitive`, the transport
 * seam both `busRequest` and the actor fan-ins (`weaverFanIn`, the
 * smelter's) consume: this adapter inside a process, the HTTP actor across
 * the gateway.
 *
 * It lets in-process callers (bootstrap, event replay, linked-data import) use
 * the same confirmed request/reply path as the SDK —
 * `busRequest(asBusRequestPrimitive(eventBus), …)` — instead of hand-rolled
 * `race(domain-event, *-failed, timeout)` blocks. The reply is matched by
 * `correlationId`, so concurrent in-process writes can't cross-match (the
 * latent bug in the old domain-event `race`).
 */
export function asBusRequestPrimitive(eventBus: EventBus): BusRequestPrimitive {
  return {
    // `async`, so a bus that refuses the emit (a destroyed one throws)
    // surfaces as a rejection. A caller that attaches `.catch` to a
    // fire-and-forget emit would not see a synchronous throw.
    async emit<K extends keyof EventMap>(channel: K, payload: EventMap[K], envelope?: BusEnvelope): Promise<undefined> {
      // The envelope rides through. `busRequest` mints the correlation key
      // onto it and matches the reply on `frame.correlationId`, so an emit
      // that dropped it here would strand every in-process request until
      // its timeout — silently, since a narrower `emit` is still assignable.
      eventBus.emit(channel, payload, envelope);
      // In-process: no subscriber accounting, so no count.
      return undefined;
    },
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
      return eventBus.on(channel);
    },
    frames<K extends keyof EventMap>(channel: K) {
      return eventBus.frames(channel);
    },
    // Every channel: an in-process bus delivers every emit, so the receive
    // path carries anything asked of it. The true answer, which is why this
    // is a required member rather than an omitted one.
    isSubscribed: () => true,
    // Nothing to track: a reply published on this bus cannot be lost to an
    // outage, so there is none to ask for again.
    trackReply: () => () => {},
    // In-process delivery is synchronous — no attach window, so `'open'` is
    // the true state. A destroyed bus throws at
    // `eventBus.on()` before the gate could matter. Published read-only
    // (X1): the subject's mutators must not leak to consumers.
    state$: new BehaviorSubject<ConnectionState>('open').asObservable(),
  };
}
