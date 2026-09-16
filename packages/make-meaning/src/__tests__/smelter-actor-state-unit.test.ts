/**
 * createSmelterActorStateUnit — unit tests.
 *
 * The state unit takes a shared bus and attaches smelter-channel fan-in. The
 * bus is the harness fake, whose `push` is typed per channel — so these tests
 * can only put on the bus what the bus actually carries. No HTTP or SSE.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import {
  createSmelterActorStateUnit,
  SMELTER_MANIFEST,
  SMELTER_CHANNELS,
  SMELTER_COMMAND_CHANNELS,
  type SmelterEvent,
} from '../smelter-actor-state-unit';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import { createFakeWorkerBus, yieldCreated, annotationEvent } from './helpers/smelter-harness';

describe('createSmelterActorStateUnit', () => {
  let h: ReturnType<typeof createFakeWorkerBus>;

  beforeEach(() => {
    h = createFakeWorkerBus();
  });

  it('every channel the fold streams is in the MANIFEST — declared, not widened', () => {
    // Was: "extends the shared bus with all 9 smelter channels on start",
    // counting a widening call. P2 deleted the verb — the fold's streams are
    // built at construction, so the manifest must already contain them or
    // the transport's own refusal throws at boot. Assert the declaration.
    const manifest = new Set<string>(SMELTER_MANIFEST);
    for (const channel of SMELTER_CHANNELS) {
      expect(manifest.has(channel), `${channel} missing from SMELTER_MANIFEST`).toBe(true);
    }
    for (const channel of SMELTER_COMMAND_CHANNELS) {
      expect(manifest.has(channel), `${channel} missing from SMELTER_MANIFEST`).toBe(true);
    }
  });

  it('passes each StoredEvent through verbatim — never re-wrapped', async () => {
    const stateUnit = createSmelterActorStateUnit({ bus: h.bus });
    stateUnit.start();

    const collected = firstValueFrom(stateUnit.events$.pipe(take(2), toArray()));

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

    stateUnit.dispose();
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

  it('start() is idempotent — one fold, not two', () => {
    const stateUnit = createSmelterActorStateUnit({ bus: h.bus });
    const seen: string[] = [];
    stateUnit.events$.subscribe((e) => seen.push(e.type));
    stateUnit.start();
    stateUnit.start();

    // This counted `addChannels` calls until P2 deleted the widening verb.
    // The real property was always this: a second start() must not deliver
    // every event twice.
    h.push('yield:created', yieldCreated('r-1'));
    expect(seen).toEqual(['yield:created']);

    stateUnit.dispose();
  });
});

describe('SmelterActorStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    // No owned surfaces: `events$` is derived from the injected bus's `on$`.
    assertStateUnitAxioms({
      setup: () => createSmelterActorStateUnit({ bus: createFakeWorkerBus().bus }),
      invocations: (u) => [() => u.start()],
    });
  });
});
