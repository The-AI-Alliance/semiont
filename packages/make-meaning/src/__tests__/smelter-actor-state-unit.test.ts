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
import { createSmelterActorStateUnit, type SmelterEvent } from '../smelter-actor-state-unit';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
import { createFakeWorkerBus, yieldCreated, annotationEvent } from './helpers/smelter-harness';

describe('createSmelterActorStateUnit', () => {
  let h: ReturnType<typeof createFakeWorkerBus>;

  beforeEach(() => {
    h = createFakeWorkerBus();
  });

  it('extends the shared bus with all 9 smelter channels on start', () => {
    const stateUnit = createSmelterActorStateUnit({ bus: h.bus });
    stateUnit.start();

    expect(h.channels.has('yield:created')).toBe(true);
    expect(h.channels.has('yield:updated')).toBe(true);
    expect(h.channels.has('yield:representation-added')).toBe(true);
    expect(h.channels.has('mark:archived')).toBe(true);
    expect(h.channels.has('mark:unarchived')).toBe(true);
    expect(h.channels.has('mark:added')).toBe(true);
    expect(h.channels.has('mark:removed')).toBe(true);
    expect(h.channels.has('mark:entity-tag-added')).toBe(true);
    expect(h.channels.has('mark:entity-tag-removed')).toBe(true);

    stateUnit.dispose();
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

  it('start() is idempotent', () => {
    const stateUnit = createSmelterActorStateUnit({ bus: h.bus });
    stateUnit.start();
    stateUnit.start();
    expect(h.bus.addChannels).toHaveBeenCalledTimes(1);

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
