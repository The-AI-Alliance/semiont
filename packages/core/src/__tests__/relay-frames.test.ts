/**
 * `relayFrames` is the only place a bus-to-bus hop is written, so it is the
 * single point of failure for the contract four shipped relays broke. The
 * census next door proves nobody hand-rolls one; this proves the one they all
 * call actually carries the envelope.
 *
 * `scope` NOT crossing is asserted here too. It was a decision recorded only in
 * a comment, and a documented contract is not a contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom, of, take, timeout } from 'rxjs';
import { EventBus } from '../event-bus';
import { relayFrames, type FrameSink, type FrameSource } from '../relay-frames';
import { assertCarriesEnvelope } from '../envelope-conformance';

const CHANNEL = 'frame:add-entity-type' as const;
const OTHER = 'beckon:hover' as const;
const PAYLOAD = { tag: 'Person' };

/** The first frame to land on `bus` for `channel`, or undefined. */
const firstFrame = (bus: EventBus, channel: typeof CHANNEL | typeof OTHER) =>
  firstValueFrom(bus.frames(channel).pipe(take(1), timeout(500))).catch(() => undefined);

/** A sink that records what it was handed, with a configurable emit result. */
function recordingSink(result: (n: number) => unknown = () => 1) {
  const seen: Array<{ channel: string; payload: unknown; envelope: unknown }> = [];
  let n = 0;
  const sink: FrameSink = {
    emit: ((channel: unknown, payload: unknown, envelope: unknown) => {
      seen.push({ channel: channel as string, payload, envelope });
      return result(n++);
    }) as FrameSink['emit'],
  };
  return { sink, seen };
}

describe('relayFrames', () => {
  it('carries the envelope across the hop (the house conformance gate)', async () => {
    const from = new EventBus();
    const to = new EventBus();
    try {
      relayFrames(from, to, [CHANNEL], () => {});
      const observed = firstFrame(to, CHANNEL).then((f) => f?.correlationId);
      // Emitting into `from` reaches `to` only through the relay, so the
      // standard gate applied to `from` is a gate on the relay.
      await assertCarriesEnvelope({
        relay: from,
        observe: () => observed,
        channel: CHANNEL,
        payload: PAYLOAD,
      });
    } finally {
      from.destroy();
      to.destroy();
    }
  });

  it('does NOT carry scope — re-scoping at a hop hides frames from unscoped subscribers', async () => {
    // A hand-made source, because `EventBus.frames()` yields only UNSCOPED
    // frames: a scoped emit lands on a different subject, so a real bus cannot
    // produce the input this branch exists for. A TRANSPORT source can — its
    // `BusEvent` declares `scope` — so this stands in for one.
    const scoped: FrameSource = {
      frames: (() => of({ payload: PAYLOAD, correlationId: 'cid-1', scope: 'urn:semiont:r-1' })) as FrameSource['frames'],
    };
    const { sink, seen } = recordingSink();
    relayFrames(scoped, sink, [CHANNEL], () => {});
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.envelope, 'scope must not cross the hop').toEqual({ correlationId: 'cid-1' });
  });

  it('catches an async sink’s rejection even though onError is now required', async () => {
    // `onError` used to be optional and the catch was guarded by it, so a
    // caller that passed nothing turned every sink rejection into an unhandled
    // promise rejection inside the one function all relays go through.
    const from = new EventBus();
    const { sink } = recordingSink(() => Promise.reject(new Error('sink down')));
    const onError = vi.fn();
    try {
      relayFrames(from, sink, [CHANNEL], onError);
      from.emit(CHANNEL, PAYLOAD, {});
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    } finally {
      from.destroy();
    }
  });

  it('forwards the payload unchanged, and relays EVERY channel in the list', async () => {
    const from = new EventBus();
    const { sink, seen } = recordingSink();
    try {
      // Two channels, because a relay that wires only the first would pass
      // every single-channel assertion above it.
      relayFrames(from, sink, [CHANNEL, OTHER], () => {});
      from.emit(CHANNEL, PAYLOAD, { correlationId: 'cid-a' });
      from.emit(OTHER, { annotationId: 'ann-1' } as never, { correlationId: 'cid-b' });
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(seen[0]).toEqual({ channel: CHANNEL, payload: PAYLOAD, envelope: { correlationId: 'cid-a' } });
      expect(seen[1]!.channel).toBe(OTHER);
      expect(seen[1]!.envelope).toEqual({ correlationId: 'cid-b' });
    } finally {
      from.destroy();
    }
  });

  it('reports an async sink’s rejection to onError, naming the channel', async () => {
    const from = new EventBus();
    const boom = new Error('gateway unreachable');
    const { sink } = recordingSink(() => Promise.reject(boom));
    const errors: Array<{ channel: unknown; error: unknown }> = [];
    try {
      relayFrames(from, sink, [CHANNEL], (channel, error) => errors.push({ channel, error }));
      from.emit(CHANNEL, PAYLOAD, { correlationId: 'cid-fail' });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toEqual({ channel: CHANNEL, error: boom });
    } finally {
      from.destroy();
    }
  });

  it('leaves onError alone for a synchronous sink', async () => {
    const from = new EventBus();
    const { sink, seen } = recordingSink(() => 1);
    const onError = vi.fn();
    try {
      relayFrames(from, sink, [CHANNEL], onError);
      from.emit(CHANNEL, PAYLOAD, { correlationId: 'cid-sync' });
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(onError, 'a sync sink has no rejection to report').not.toHaveBeenCalled();
    } finally {
      from.destroy();
    }
  });

  it('stops relaying once its subscriptions are torn down', async () => {
    const from = new EventBus();
    const { sink, seen } = recordingSink();
    try {
      // The service pumps push these into a list and unsubscribe them on
      // shutdown; a relay that ignored the handle would outlive its process.
      const subs = relayFrames(from, sink, [CHANNEL], () => {});
      from.emit(CHANNEL, PAYLOAD, { correlationId: 'cid-before' });
      await vi.waitFor(() => expect(seen).toHaveLength(1));

      for (const s of subs) s.unsubscribe();
      from.emit(CHANNEL, PAYLOAD, { correlationId: 'cid-after' });
      await new Promise((r) => setTimeout(r, 20));
      expect(seen, 'a torn-down relay kept forwarding').toHaveLength(1);
      // The `[bus DROP]` line this prints is expected, and is itself the
      // evidence: the bus reports 0 subscribers because the relay detached.
    } finally {
      from.destroy();
    }
  });
});
