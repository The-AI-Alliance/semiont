/**
 * The in-process relay this package owns must carry the frame's envelope.
 *
 * The gate is a runtime one because the defect is: `emit`'s third parameter is
 * optional in the interface, so an implementation that declares only two
 * typechecks, delivers every payload, and drops the correlation key. The
 * compiler has nothing to say; the symptom is the Archivist hanging on its
 * entity-type bootstrap, which awaits a reply keyed on exactly that key.
 */

import { describe, it } from 'vitest';
import { EventBus } from '@semiont/core';
import { assertCarriesEnvelope } from '@semiont/core/testing';
import { firstValueFrom, take, timeout } from 'rxjs';
import { asBusRequestPrimitive } from '../bus-request-local';

const CHANNEL = 'frame:add-entity-type' as const;
const PAYLOAD = { tag: 'Person' };

/** The key on the first frame that lands on `bus`, or undefined if none does. */
const firstKey = (bus: EventBus) =>
  firstValueFrom(bus.frames(CHANNEL).pipe(take(1), timeout(500)))
    .then((frame) => frame.correlationId)
    .catch(() => undefined);

describe('the in-process relay carries the frame envelope', () => {
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
});
