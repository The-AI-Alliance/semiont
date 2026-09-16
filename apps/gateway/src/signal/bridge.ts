/**
 * The gateway-resident handler bridge (SIGNAL-PLANE P3 GREEN — the H2 fix).
 *
 * `registerGatewayBusHandlers` (make-meaning) subscribes and emits on the
 * process's EventBus — the right home for its in-process neighbors
 * (`mark:*` relays, `job:checkpoint`). Under a REMOTE plane that bus is an
 * island: the emit route dispatches through `plane.ingest` alone, so an
 * HTTP-emitted `job:create` reached the broker and no handler. This bridge
 * reconnects the island, both directions, deriving each direction's channel
 * set from the generated classification rather than restating it:
 *
 *  - INBOUND: the handlers' wire-arriving subscriptions (direction ≠
 *    'in-process') join ONE handler-mode group — so across N replicas each
 *    command executes on at most one, never two (D2 group 2, the reason
 *    handler mode exists) — and land on this replica's bus;
 *  - OUTBOUND: the handlers' wire-bound emissions (replies and their kin)
 *    leave the bus through `plane.ingest`, the q0(a) funnel made literal.
 *
 * Installed by the composition root EXACTLY when it selected a remote
 * plane. Under the in-process driver the plane IS the bus — handlers hear
 * ingests directly and their emissions are already plane-visible — so a
 * bridge there would double-deliver every frame. That conditional lives
 * once, at the root (`index.ts`), beside the driver selection itself.
 *
 * Loop safety is structural, not hoped: a channel bridged in AND out would
 * echo forever, so overlapping sets are refused at construction.
 */
import type { EventBus, EventMap } from '@semiont/core';
import { channelAttrsOf } from '@semiont/core';
import type { Subscription } from 'rxjs';
import type { SignalPlane } from './interface';

/** The one competing-consumer group name for gateway-resident handlers. */
export const GATEWAY_HANDLER_GROUP = 'gateway';

export function bridgeGatewayHandlers(
  plane: SignalPlane,
  eventBus: EventBus,
  consumed: readonly (keyof EventMap)[],
  emitted: readonly (keyof EventMap)[],
): { close(): void } {
  const wireOnly = (channels: readonly (keyof EventMap)[]) =>
    channels.filter((channel) => channelAttrsOf(channel)?.direction !== 'in-process');

  const inboundChannels = wireOnly(consumed);
  const outboundChannels = wireOnly(emitted);
  const overlap = inboundChannels.filter((channel) => outboundChannels.includes(channel));
  if (overlap.length > 0) {
    throw new Error(`signal bridge: channel(s) bridged both directions would loop: ${overlap.join(', ')}`);
  }

  const inbound = plane.subscribeHandlers(GATEWAY_HANDLER_GROUP, inboundChannels, (channel, payload) => {
    eventBus.get(channel as keyof EventMap).next(payload as never);
  });
  const outbound: Subscription[] = outboundChannels.map((channel) =>
    eventBus.get(channel).subscribe((payload) => {
      plane.ingest(channel, payload);
    }),
  );

  return {
    close() {
      inbound.close();
      for (const sub of outbound) sub.unsubscribe();
    },
  };
}
