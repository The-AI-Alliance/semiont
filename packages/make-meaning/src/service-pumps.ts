/**
 * Inbound frames from the transport onto the local bus, outbound replies back.
 * Lives outside `main()` so tests construct what the entry points construct.
 */
import type { EventBus, EventMap, FrameSink, FrameSource, Logger } from '@semiont/core';
import { errField, relayFrames } from '@semiont/core';
import type { Subscription } from 'rxjs';

/** Both halves of the hop. */
export type PumpTransport = FrameSource & FrameSink;

export interface ServicePumpSpec {
  transport: PumpTransport;
  localBus: EventBus;
  /** Requests and signals consumed; also the SSE subscription. */
  inbound: readonly (keyof EventMap)[];
  /** Replies emitted, derived from `inbound` and disjoint from it. */
  outbound: readonly (keyof EventMap)[];
  logger: Pick<Logger, 'error'>;
}

/** One subscription per channel per direction. */
export function attachServicePumps(spec: ServicePumpSpec): Subscription[] {
  const { transport, localBus, inbound, outbound, logger } = spec;
  return [
    ...relayFrames(transport, localBus, inbound, (channel, error) =>
      logger.error('Inbound relay failed', { channel, error: errField(error) }),
    ),
    ...relayFrames(localBus, transport, outbound, (channel, error) =>
      logger.error('Reply forwarding failed', { channel, error: errField(error) }),
    ),
  ];
}
