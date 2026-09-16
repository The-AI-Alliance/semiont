/**
 * workerBusOverEventBus Tests (WEAVER-ISOLATION P2)
 *
 * The in-process BusRequestPrimitive shim over the core EventBus — the "in-process
 * bus shim" the smelter's fan-in anticipated. Lets any BusRequestPrimitive consumer
 * (WeaverActorStateUnit today) run inside the gateway unchanged.
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '@semiont/core';
import { workerBusOverEventBus } from '../worker-bus-local';

describe('workerBusOverEventBus', () => {
  it('on$ delivers what the EventBus carries, verbatim', () => {
    const eventBus = new EventBus();
    const bus = workerBusOverEventBus(eventBus);

    const seen: unknown[] = [];
    bus.stream('mark:added').subscribe((e) => seen.push(e));

    const stored = { type: 'mark:added', resourceId: 'r1', payload: {}, metadata: { sequenceNumber: 3 } };
    eventBus.get('mark:added').next(stored as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(stored);
  });

  it('emit lands on EventBus subscribers', async () => {
    const eventBus = new EventBus();
    const bus = workerBusOverEventBus(eventBus);

    const seen: unknown[] = [];
    eventBus.get('weave:applied').subscribe((e) => seen.push(e));

    await bus.emit('weave:applied', { resourceId: 'r1', sequenceNumber: 4 });

    expect(seen).toEqual([{ resourceId: 'r1', sequenceNumber: 4 }]);
  });

  // RED (CLIENT-SUBSCRIPTION-MANIFEST P1, D1) — every transport ANSWERS.
  //
  // `isSubscribed` is not optional. The question it asks — "does this
  // transport's receive path deliver `channel`?" — has a true answer for
  // every transport, and for an in-process bus that answer is `true` for
  // every channel: it delivers every emit. Leaving it absent made the
  // interface two dialects and forced `busRequest` to branch on which one it
  // held (`if (bus.isSubscribed)`), so the refusal ran or did not depending
  // on the implementation rather than on the truth.
  it('answers isSubscribed for every channel — an in-process bus delivers them all', () => {
    const eventBus = new EventBus();
    const bus = workerBusOverEventBus(eventBus);

    expect(bus.isSubscribed('job:queued')).toBe(true);
    expect(bus.isSubscribed('mark:added')).toBe(true);
  });

  it('streams any channel — nothing is outside a set that has no bound', () => {
    const eventBus = new EventBus();
    const bus = workerBusOverEventBus(eventBus);

    const seen: unknown[] = [];
    expect(() => bus.stream('job:queued').subscribe((e) => seen.push(e))).not.toThrow();

    eventBus.get('job:queued').next({ jobId: 'j1', jobType: 'generate', resourceId: 'r1', userId: 'did:u1' });

    expect(seen).toEqual([{ jobId: 'j1', jobType: 'generate', resourceId: 'r1', userId: 'did:u1' }]);
  });
});
