/**
 * The gateway's own in-process relay must carry the frame's envelope.
 *
 * `requestPrimitiveFor` is what a gateway-internal `busRequest` emits through.
 * It ferries the envelope into the plane's `meta` without naming a key of it
 * (the P0.5 census); this gate proves the ferry actually moves something,
 * which the census alone cannot.
 */

import { describe, it, afterEach } from 'vitest';
import { EventBus } from '@semiont/core';
import { assertCarriesEnvelope } from '@semiont/core/testing';
import { firstValueFrom, take, timeout } from 'rxjs';
import { requestPrimitiveFor } from '../request-primitive';

const CHANNEL = 'frame:add-entity-type' as const;

describe('the gateway request primitive carries the frame envelope', () => {
  let bus: EventBus | undefined;
  afterEach(() => bus?.destroy());

  it('emits through the plane with the key intact', async () => {
    bus = new EventBus();
    const observed = firstValueFrom(bus.frames(CHANNEL).pipe(take(1), timeout(500)))
      .then((frame) => frame.correlationId)
      .catch(() => undefined);

    await assertCarriesEnvelope({
      relay: requestPrimitiveFor(bus),
      observe: () => observed,
      channel: CHANNEL,
      payload: { tag: 'Person' },
    });
  });
});
