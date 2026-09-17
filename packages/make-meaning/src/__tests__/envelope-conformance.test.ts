/**
 * Every in-process relay this package owns must carry the frame's envelope.
 *
 * The gate is a runtime one because the defect is: `emit`'s third parameter is
 * optional in the interface, so an implementation that declares only two
 * typechecks, delivers every payload, and drops the correlation key. All three
 * relays here were written that way and the compiler had nothing to say — the
 * symptom was `startMakeMeaning` hanging on its entity-type bootstrap, which
 * awaits a reply keyed on exactly that key.
 */

import { describe, it } from 'vitest';
import { EventBus, userDID } from '@semiont/core';
import { assertCarriesEnvelope } from '@semiont/core/testing';
import { firstValueFrom, take, timeout } from 'rxjs';
import { asBusRequestPrimitive } from '../bus-request-local';
import { workerBusOverEventBus } from '../worker-bus-local';
import { LocalTransport } from '../local-transport';

const CHANNEL = 'frame:add-entity-type' as const;
const PAYLOAD = { tag: 'Person' };

/** The key on the first frame that lands on `bus`, or undefined if none does. */
const firstKey = (bus: EventBus) =>
  firstValueFrom(bus.frames(CHANNEL).pipe(take(1), timeout(500)))
    .then((frame) => frame.correlationId)
    .catch(() => undefined);

describe('in-process relays carry the frame envelope', () => {
  it('asBusRequestPrimitive', async () => {
    const bus = new EventBus();
    try {
      const observed = firstKey(bus);
      await assertCarriesEnvelope({
        relay: asBusRequestPrimitive(bus),
        observe: () => observed,
        channel: CHANNEL,
        payload: PAYLOAD,
      });
    } finally {
      bus.destroy();
    }
  });

  it('workerBusOverEventBus', async () => {
    const bus = new EventBus();
    try {
      const observed = firstKey(bus);
      await assertCarriesEnvelope({
        relay: workerBusOverEventBus(bus),
        observe: () => observed,
        channel: CHANNEL,
        payload: PAYLOAD,
      });
    } finally {
      bus.destroy();
    }
  });

  it('LocalTransport', async () => {
    const bus = new EventBus();
    const transport = new LocalTransport({ eventBus: bus, userId: userDID('did:semiont:test') });
    try {
      const observed = firstKey(bus);
      await assertCarriesEnvelope({
        relay: transport,
        observe: () => observed,
        channel: CHANNEL,
        payload: PAYLOAD,
      });
    } finally {
      transport.dispose();
    }
  });
});
