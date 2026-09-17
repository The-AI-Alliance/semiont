/**
 * `service-channels.test.ts` proves the rosters as SETS — and every one of
 * those assertions was green while both services dropped the correlation key
 * on every reply, because a set cannot observe a hop. So: for each operation a
 * service answers, require the reply back with its correlationId.
 *
 * Calls `attachServicePumps`, not a local re-wiring of `relayFrames` — a test
 * that builds its own copy of the wiring is green whatever the wiring does.
 */
import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import {
  BUS_OPERATIONS,
  EventBus,
  type BusFrame,
  type EventMap,
  type FrameSink,
  type FrameSource,
} from '@semiont/core';
import {
  ARCHIVIST_INBOUND_CHANNELS,
  ARCHIVIST_OUTBOUND_CHANNELS,
  LIBRARIAN_INBOUND_CHANNELS,
  LIBRARIAN_OUTBOUND_CHANNELS,
} from '../service-channels';
import { attachServicePumps, type PumpTransport } from '../service-pumps';

/** Stands in for HTTP: frames cross verbatim, both directions. */
function loopback() {
  const toService = new Map<string, Subject<BusFrame<unknown>>>();
  const fromService: Array<{ channel: string; payload: unknown; correlationId?: string }> = [];

  const subjectFor = (channel: string) => {
    let s = toService.get(channel);
    if (!s) { s = new Subject<BusFrame<unknown>>(); toService.set(channel, s); }
    return s;
  };

  const transport: PumpTransport = {
    frames: ((channel: string) => subjectFor(channel)) as FrameSource['frames'],
    emit: ((channel: string, payload: unknown, envelope: { correlationId?: string }) => {
      fromService.push({ channel, payload, correlationId: envelope?.correlationId });
      return 1;
    }) as FrameSink['emit'],
  };

  const dispatch = (channel: string, payload: unknown, correlationId: string) =>
    subjectFor(channel).next({ payload, correlationId } as BusFrame<unknown>);

  return { transport, dispatch, fromService };
}

interface ServiceCase {
  name: string;
  inbound: readonly (keyof EventMap)[];
  outbound: readonly (keyof EventMap)[];
}

const SERVICES: ServiceCase[] = [
  { name: 'Archivist', inbound: ARCHIVIST_INBOUND_CHANNELS, outbound: ARCHIVIST_OUTBOUND_CHANNELS },
  { name: 'Librarian', inbound: LIBRARIAN_INBOUND_CHANNELS, outbound: LIBRARIAN_OUTBOUND_CHANNELS },
];

/** Operations whose request is inbound and whose reply is outbound. */
const operationsOf = (svc: ServiceCase) =>
  Object.entries(BUS_OPERATIONS).filter(
    ([request, op]) =>
      (svc.inbound as readonly string[]).includes(request) &&
      (svc.outbound as readonly string[]).includes(op.result),
  );

describe.each(SERVICES)('$name — every operation it answers round-trips', (svc) => {
  const operations = operationsOf(svc);

  it('answers at least one operation (a roster that answers nothing would pass vacuously)', () => {
    expect(operations.length, `${svc.name} answers no operation — check the rosters`).toBeGreaterThan(0);
  });

  it.each(operations)('%s → its reply returns with the correlationId', (request, op) => {
    const localBus = new EventBus();
    const { transport, dispatch, fromService } = loopback();
    const errors: unknown[] = [];
    const pumps = attachServicePumps({
      transport,
      localBus,
      inbound: svc.inbound,
      outbound: svc.outbound,
      logger: { error: (_m: string, meta?: unknown) => errors.push(meta) },
    });

    try {
      // A handler: key off the frame, back onto the reply.
      const handler = localBus.frames(request as keyof EventMap).subscribe((frame) => {
        localBus.emit(op.result, {} as never, { correlationId: frame.correlationId });
      });

      const cid = `rt-${request}`;
      dispatch(request, {}, cid);

      const reply = fromService.find((f) => f.channel === op.result);
      expect(reply, `${request}: no reply left the service — the inbound pump did not deliver it`).toBeDefined();
      expect(
        reply!.correlationId,
        `${request}: the reply came back UNADDRESSED. Every caller awaiting it times out with no error — ` +
          `an unaddressed reply is never matched, so every caller waits out its timeout.`,
      ).toBe(cid);
      expect(errors, 'a pump reported an error').toEqual([]);
      handler.unsubscribe();
    } finally {
      for (const p of pumps) p.unsubscribe();
      localBus.destroy();
    }
  });
});
