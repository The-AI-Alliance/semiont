/**
 * RED (BUS-CARRIES-FRAMES P3): the correlation key rides the ENVELOPE, and a
 * requester matches its reply without reading a payload.
 *
 * At RED, `correlationId` was declared in 71 payload schemas and echoed by hand
 * in nine handlers (zero today — it rides the envelope), while its other half
 * `clientId` already sat correctly on the envelope —
 * under a description that states the very rule being broken: routing is "a
 * wire concern like `scope`, so it never enters a channel's domain type".
 *
 * The bus now has an envelope to put it on (P0-P2), so the rule can finally be
 * followed. These assertions are over the RUNTIME contract, deliberately: a
 * gate on schema TEXT would go green by deleting declarations while the wire
 * stayed exactly as it was.
 */
import { describe, test, expect } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { EventBus } from '../event-bus';
import { busRequest } from '../bus-request';
import type { BusRequestPrimitive } from '../bus-request';
import type { EventMap } from '../bus-protocol';

const OP = 'gather:resource-requested' as const;
const RESULT = 'gather:resource-complete' as const;

/** A responder that echoes the envelope, as a real handler must. */
function respondingBus(): { bus: BusRequestPrimitive; seen: Array<{ correlationId?: string; payload: unknown }> } {
  const eventBus = new EventBus();
  const seen: Array<{ correlationId?: string; payload: unknown }> = [];

  eventBus.frames(OP).subscribe((frame) => {
    seen.push({ correlationId: frame.correlationId, payload: frame.payload });
    // The echo: the key comes off the envelope and goes back on one.
    eventBus.emit(
      RESULT,
      { response: { answered: true } } as unknown as EventMap[typeof RESULT],
      { correlationId: frame.correlationId },
    );
  });

  const bus: BusRequestPrimitive = {
    emit: async (channel, payload, envelope) => eventBus.emit(channel, payload, envelope),
    frames: (channel) => eventBus.frames(channel),
    stream: (channel) => eventBus.on(channel),
    state$: new BehaviorSubject<'open'>('open').asObservable(),
    isSubscribed: () => true,
  } as BusRequestPrimitive;
  return { bus, seen };
}

describe('correlation rides the envelope', () => {
  test('busRequest puts the key on the ENVELOPE, not in the payload', async () => {
    const { bus, seen } = respondingBus();

    await busRequest(bus, OP, { resourceId: 'res-1' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.correlationId, 'the envelope carries it').toEqual(expect.any(String));
    expect(
      Object.keys(seen[0]!.payload as object),
      'the domain payload is untouched by routing metadata',
    ).not.toContain('correlationId');
  });

  test('a requester matches its reply without reading the payload', async () => {
    const { bus } = respondingBus();

    // Two requests in flight at once: pairing can only come from the envelope,
    // because neither payload carries anything to pair on.
    const [a, b] = await Promise.all([
      busRequest(bus, OP, { resourceId: 'res-a' }),
      busRequest(bus, OP, { resourceId: 'res-b' }),
    ]);

    expect(a).toEqual({ answered: true });
    expect(b).toEqual({ answered: true });
  });

  test('a reply whose envelope carries the WRONG key is not delivered to this requester', async () => {
    const eventBus = new EventBus();
    const bus: BusRequestPrimitive = {
      emit: async (channel, payload, envelope) => {
        const observers = eventBus.emit(channel, payload, envelope);
        // Answer with a key nobody is waiting on.
        eventBus.emit(RESULT, { response: { answered: 'wrong' } } as never, { correlationId: 'not-yours' });
        return observers;
      },
      frames: (channel) => eventBus.frames(channel),
      stream: (channel) => eventBus.on(channel),
      state$: new BehaviorSubject<'open'>('open').asObservable(),
      isSubscribed: () => true,
    } as BusRequestPrimitive;

    await expect(busRequest(bus, OP, { resourceId: 'res-1' }, 120)).rejects.toMatchObject({
      code: 'bus.timeout',
    });
  });
});
