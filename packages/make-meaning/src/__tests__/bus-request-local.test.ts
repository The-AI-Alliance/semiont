/**
 * asBusRequestPrimitive — the in-process `BusRequestPrimitive` over the core
 * EventBus. `busRequest` callers inside the process and the actor fan-ins
 * (`weaverFanIn`, the smelter's) both run on it.
 */

import { describe, it, expect } from 'vitest';
import { EventBus, resourceId, jobId, userId } from '@semiont/core';
import { asBusRequestPrimitive } from '../bus-request-local';

describe('asBusRequestPrimitive', () => {
  it('stream delivers what the EventBus carries, verbatim', () => {
    const eventBus = new EventBus();
    const bus = asBusRequestPrimitive(eventBus);

    const seen: unknown[] = [];
    bus.stream('mark:added').subscribe((e) => seen.push(e));

    const stored = { type: 'mark:added', resourceId: 'r1', payload: {}, metadata: { sequenceNumber: 3 } };
    eventBus.emit('mark:added', stored as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(stored);
  });

  it('emit lands on EventBus subscribers', async () => {
    const eventBus = new EventBus();
    const bus = asBusRequestPrimitive(eventBus);

    const seen: unknown[] = [];
    eventBus.on('weave:applied').subscribe((e) => seen.push(e));

    await bus.emit('weave:applied', { resourceId: resourceId('r1'), sequenceNumber: 4 });

    expect(seen).toEqual([{ resourceId: 'r1', sequenceNumber: 4 }]);
  });

  // `emit` returns a promise, so a failure is a rejection. The Weaver's
  // `weave:applied` signal is fire-and-forget with a `.catch` attached
  // (weaver.ts), and the bus under it can be destroyed first at teardown: a
  // synchronous throw would escape that `.catch` into the event handler.
  it('emit on a destroyed bus rejects; it never throws', async () => {
    const eventBus = new EventBus();
    const bus = asBusRequestPrimitive(eventBus);
    eventBus.destroy();

    let emitted: Promise<unknown> | undefined;
    expect(() => {
      emitted = bus.emit('weave:applied', { resourceId: resourceId('r1'), sequenceNumber: 4 });
    }).not.toThrow();
    await expect(emitted).rejects.toThrow(/destroyed bus/);
  });

  // Every transport ANSWERS.
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
    const bus = asBusRequestPrimitive(eventBus);

    expect(bus.isSubscribed('job:queued')).toBe(true);
    expect(bus.isSubscribed('mark:added')).toBe(true);
  });

  it('streams any channel — nothing is outside a set that has no bound', () => {
    const eventBus = new EventBus();
    const bus = asBusRequestPrimitive(eventBus);

    const seen: unknown[] = [];
    expect(() => bus.stream('job:queued').subscribe((e) => seen.push(e))).not.toThrow();

    eventBus.emit('job:queued', { jobId: jobId('j1'), jobType: 'generate', resourceId: resourceId('r1'), userId: userId('did:u1') });

    expect(seen).toEqual([{ jobId: 'j1', jobType: 'generate', resourceId: 'r1', userId: 'did:u1' }]);
  });
});
