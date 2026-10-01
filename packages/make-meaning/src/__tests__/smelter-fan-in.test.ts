/**
 * smelterFanIn — unit tests.
 *
 * The fan-in takes a shared bus and merges the smelter channels. The bus is
 * the harness fake, whose `push` is typed per channel — so these tests can
 * only put on the bus what the bus actually carries. No HTTP or SSE.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import {
  smelterFanIn,
  SMELTER_MANIFEST,
  SMELTER_CHANNELS,
  SMELTER_COMMAND_CHANNELS,
  type SmelterEvent,
} from '../smelter-fan-in';
import { createFakeBus, yieldCreated, annotationEvent } from './helpers/smelter-harness';

describe('smelterFanIn', () => {
  let h: ReturnType<typeof createFakeBus>;

  beforeEach(() => {
    h = createFakeBus();
  });

  it('every channel the fold streams is in the MANIFEST — declared, not widened', () => {
    // The fan-in asks the bus for its streams the moment it is called, so the
    // manifest must already contain them or the transport's own refusal
    // throws at boot. Assert the declaration.
    const manifest = new Set<string>(SMELTER_MANIFEST);
    for (const channel of SMELTER_CHANNELS) {
      expect(manifest.has(channel), `${channel} missing from SMELTER_MANIFEST`).toBe(true);
    }
    for (const channel of SMELTER_COMMAND_CHANNELS) {
      expect(manifest.has(channel), `${channel} missing from SMELTER_MANIFEST`).toBe(true);
    }
  });

  it('passes each StoredEvent through verbatim — never re-wrapped', async () => {
    const { events$ } = smelterFanIn(h.bus);

    const collected = firstValueFrom(events$.pipe(take(2), toArray()));

    const created = yieldCreated('r-1');
    const added = annotationEvent('r-1', 'a-1', 'quoted');
    h.push('yield:created', created);
    h.push('mark:added', added);

    const [first, second] = await collected;
    // The same object — not a copy, not an envelope around it. A fan-in that
    // re-nested the message under its own `payload` once made handlers read
    // `event.payload.annotationId` one level too shallow, silently.
    expect(first).toBe(created);
    expect(second).toBe(added);
  });

  it('an event with no resource cannot be constructed', () => {
    // A real event minus exactly one field, so the directive below holds on
    // `resourceId` alone: every channel the Smelter hears is a resource event
    // on the wire (none is a SystemEventType).
    const { resourceId: _dropped, ...noResource } = yieldCreated('r-1');
    // @ts-expect-error — resourceId is required
    const event: SmelterEvent = noResource;
    expect(event).toBeDefined();
  });
});
