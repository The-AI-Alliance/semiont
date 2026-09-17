/**
 * The one frame relay.
 *
 * Every hop between two buses is this: subscribe a channel's frames, re-emit
 * them with their envelope intact. Written by hand it is three correct-looking
 * lines that typecheck whether or not the envelope survives — `stream()` is
 * payload-only, the envelope on `emit` is optional, and a relay that never
 * mentions `correlationId` drops it in silence. Ten such relays shipped; four
 * were dropping it.
 *
 * `scope` deliberately does NOT cross. The transport flattens its scoped
 * fan-in into one delivery and consumers read those off the unscoped bus, so
 * re-scoping at a relay hides frames from every existing subscriber. A pump
 * that genuinely owns a scope (the Archivist's fact pump) emits directly.
 */
import type { Observable, Subscription } from 'rxjs';
import type { BusEnvelope, BusFrame } from './event-bus';
import type { EventMap } from './bus-protocol';

/** Anything that publishes a channel's frames: `EventBus`, `ITransport`. */
export interface FrameSource {
  frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>>;
}

/**
 * Anything that accepts an emitted frame. The envelope is REQUIRED here even
 * though both implementations take it optionally — a sink reached through this
 * type cannot be handed a payload alone.
 */
export interface FrameSink {
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K], envelope: BusEnvelope): unknown;
}

/** Per-channel so `K` is one channel's type, not the union of all of them. */
function relayChannel<K extends keyof EventMap>(
  from: FrameSource,
  to: FrameSink,
  channel: K,
  onError: ((channel: K, error: unknown) => void) | undefined,
): Subscription {
  return from.frames(channel).subscribe((frame) => {
    const delivered = to.emit(channel, frame.payload, { correlationId: frame.correlationId });
    if (onError && delivered instanceof Promise) {
      delivered.catch((error: unknown) => onError(channel, error));
    }
  });
}

/**
 * Relay `channels` from one bus to another, envelope intact.
 *
 * `onError` receives a rejection from an async sink (an HTTP emit); a
 * synchronous sink never calls it. Returns one subscription per channel.
 */
export function relayFrames(
  from: FrameSource,
  to: FrameSink,
  channels: readonly (keyof EventMap)[],
  onError?: (channel: keyof EventMap, error: unknown) => void,
): Subscription[] {
  return channels.map((channel) => relayChannel(from, to, channel, onError));
}
