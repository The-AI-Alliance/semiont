/**
 * Request-response over the Signal Plane, for routes that delegate to bus
 * actors living out-of-process; the route never knows where the answering
 * actor lives.
 *
 * Rewritten at SIGNAL-PLANE P3 to ride the PLANE instead of the raw
 * EventBus: the old RxJS version emitted and listened on the in-process bus,
 * which a remote driver never feeds — under `[signal] type = "nats"` the
 * request reached nobody and the reply had no path back (the q0(a) funnel,
 * made literal). Same composition the SSE routes use (`compositionFor`), so
 * one driver selection covers this path too.
 *
 * The correlationIds minted here are deliberately NEVER claimed: this is
 * the structural in-process requester the ledger's `mayDeliver` docstring
 * names — the reply is consumed right here, entitled to nobody else, and
 * retention would hold payloads for a caller that cannot reconnect.
 *
 * Pattern: subscribe success + failure channels → emit request → resolve on
 * the frame matching this correlationId, reject on failure or timeout.
 * Subscribe-before-ingest is ordering-safe under both drivers: in-process
 * dispatch is synchronous after subscription, and the NATS client flushes
 * SUB before PUB on one connection.
 */
import { BUS_REQUEST_TIMEOUT_MS, type EventMap } from '@semiont/core';
import type { EventBus } from '@semiont/core';
import { compositionFor, toReplyAddress } from '../signal';

type EventName = keyof EventMap;

/**
 * Send a request event and await a correlated response or failure.
 *
 * @param eventBus - The EventBus instance (names the composition)
 * @param requestEvent - Event name to emit
 * @param payload - Event payload (must include correlationId)
 * @param successEvent - Event name for successful response
 * @param failureEvent - Event name for failure
 * @param timeoutMs - Timeout in milliseconds (default: the busRequest deadline)
 * @returns The response field from the success event
 */
export async function eventBusRequest<
  TReq extends EventName,
  TSuccess extends EventName,
  TFailure extends EventName,
>(
  eventBus: EventBus,
  requestEvent: TReq,
  payload: EventMap[TReq],
  successEvent: TSuccess,
  failureEvent: TFailure,
  timeoutMs = BUS_REQUEST_TIMEOUT_MS,
): Promise<(EventMap[TSuccess] & { response: unknown })['response']> {
  const correlationId = (payload as { correlationId?: unknown }).correlationId;
  if (typeof correlationId !== 'string' || correlationId === '') {
    throw new Error(`eventBusRequest(${requestEvent}): payload must carry a correlationId`);
  }
  const plane = compositionFor(eventBus).plane;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closed on a microtask: the driver is mid-delivery in this frame's
      // callback, and both drivers tolerate it — this just keeps teardown
      // out of their iteration.
      queueMicrotask(() => sub.close());
      done();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`bus request ${requestEvent} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const sub = plane.subscribeClient({
      address: toReplyAddress(`bus-request:${correlationId}`),
      global: [successEvent, failureEvent],
      scoped: [],
      onFrame: (channel, framePayload) => {
        const frame = framePayload as { correlationId?: unknown; response?: unknown; message?: unknown } | null;
        if (frame === null || frame.correlationId !== correlationId) return;
        if (channel === successEvent) {
          settle(() => resolve(frame.response));
        } else {
          settle(() => reject(new Error(typeof frame.message === 'string' ? frame.message : `bus request ${requestEvent} failed`)));
        }
      },
    });

    plane.ingest(requestEvent, payload);
  });
}
