/**
 * workerBusOverEventBus Tests (WEAVER-ISOLATION P2)
 *
 * The in-process WorkerBus shim over the core EventBus — the "in-process
 * bus shim" the smelter's fan-in anticipated. Lets any WorkerBus consumer
 * (WeaverActorStateUnit today) run inside the backend unchanged.
 */

import { describe, it, expect } from 'vitest';
import { EventBus } from '@semiont/core';
import { workerBusOverEventBus } from '../worker-bus-local';

describe('workerBusOverEventBus', () => {
  it('on$ delivers what the EventBus carries, verbatim', () => {
    const eventBus = new EventBus();
    const bus = workerBusOverEventBus(eventBus);

    const seen: unknown[] = [];
    bus.on$('mark:added').subscribe((e) => seen.push(e));

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

  it('addChannels is a no-op — the in-process bus already delivers every emit', () => {
    const eventBus = new EventBus();
    const bus = workerBusOverEventBus(eventBus);

    expect(() => bus.addChannels?.(['mark:added'])).not.toThrow();
  });
});
