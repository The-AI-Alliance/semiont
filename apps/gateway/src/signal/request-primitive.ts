/**
 * The gateway's `BusRequestPrimitive` — request/reply over the PLANE
 * (SIGNAL-PLANE P3, the `yield:create` starvation fix:
 * `.plans/bugs/yield-create-unbridged-starves-resource-creation.md`).
 *
 * `asBusRequestPrimitive` (make-meaning) adapts a raw in-process EventBus;
 * that is correct for a process whose handlers live on its own bus (the
 * in-process root, the Archivist beside its Stower) and WRONG for the
 * gateway, whose remote actors subscribe through the plane: under
 * `type = "nats"` a raw-bus emit reaches no broker, no Archivist, nobody —
 * `[bus DROP]`, then the caller's full timeout. Every gateway-internal
 * `busRequest` therefore rides THIS primitive (a driver-boundary gate bans
 * the raw one from the gateway), which is driver-agnostic: over the
 * in-process plane it is bit-for-bit the old behavior.
 *
 * `state$` is constant `'open'` and `trackReply` is omitted, both for the
 * in-process reason: the requester lives and dies with this process, so
 * there is no attach window and no reconnect to recover across —
 * `busRequest`'s timeout covers a broker outage.
 */
import { BehaviorSubject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { BusFrame, BusRequestPrimitive, ConnectionState, EventBus, EventMap } from '@semiont/core';
import { compositionFor } from './composition';
import { toReplyAddress } from './interface';

/** One inert inbox for every gateway-internal request subscription: nothing
 *  is ever delivered TO it, so sharing the name leaks nothing. */
const GATEWAY_REQUEST_ADDRESS = toReplyAddress('gateway-request');

const OPEN: Observable<ConnectionState> = new BehaviorSubject<ConnectionState>('open').asObservable();

export function requestPrimitiveFor(eventBus: EventBus): BusRequestPrimitive {
  const plane = compositionFor(eventBus).plane;
  return {
    emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<number> {
      const receipt = plane.ingest(channel, payload);
      // ITransport's "unknown" sentinel when the fabric cannot count.
      return Promise.resolve(receipt.observers ?? -1);
    },
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
      return this.frames(channel).pipe(map((frame) => frame.payload));
    },

    /**
     * The envelope view over the plane. The driver hands the frame's
     * correlation key straight through, so a gateway-internal `busRequest`
     * pairs its reply without the key ever entering a payload.
     */
    frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>> {
      return new Observable<BusFrame<EventMap[K]>>((subscriber) => {
        const sub = plane.subscribeClient({
          address: GATEWAY_REQUEST_ADDRESS,
          global: [channel],
          scoped: [],
          // Spread, never destructured: this file sits behind the driver
          // boundary, so it ferries the envelope's metadata into the frame
          // without naming a key of it. The P0.5 census counts it as seam
          // code, and it is right to — a primitive that read the correlation
          // vocabulary would be gateway policy living below the seam.
          onFrame: (_channel, payload, envelope) =>
            subscriber.next({
              ...envelope.meta,
              scope: envelope.scope,
              payload: payload as EventMap[K],
            }),
        });
        return () => sub.close();
      });
    },
    // Every channel: `stream` subscribes the plane on demand for whatever
    // channel it is handed, so there is no set to be outside of. The true
    // answer for this primitive, not a stub.
    isSubscribed: () => true,
    state$: OPEN,
  };
}
