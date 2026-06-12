/**
 * createSmelterActorStateUnit — unit tests.
 *
 * The state unit takes a shared bus and attaches smelter-channel fan-in.
 * We fake the bus with a minimal object that satisfies the WorkerBus shape
 * and drive events through RxJS subjects. No HTTP or SSE involved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject, firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { createSmelterActorStateUnit } from '../smelter-actor-state-unit';
import type { WorkerBus } from '@semiont/sdk';

function fakeBus() {
  const channels = new Set<string>();
  const streams = new Map<string, Subject<any>>();

  const getStream = (channel: string): Subject<any> => {
    let s = streams.get(channel);
    if (!s) {
      s = new Subject();
      streams.set(channel, s);
    }
    return s;
  };

  const bus: WorkerBus = {
    addChannels: vi.fn((cs: readonly string[]) => {
      cs.forEach((c) => channels.add(c));
    }),
    on$: vi.fn((channel: string) => getStream(channel).asObservable()),
    // Required by the WorkerBus shape; the smelter state unit is a silent
    // sink (SMELTER-AXIOMS.md, D3) and never calls it.
    emit: vi.fn(async () => {}),
  };

  return {
    bus,
    channels,
    pushEvent: (channel: string, payload: any) => getStream(channel).next(payload),
  };
}

describe('createSmelterActorStateUnit', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('extends the shared bus with all 6 smelter channels on start', () => {
    const stateUnit = createSmelterActorStateUnit({ bus: h.bus });
    stateUnit.start();

    expect(h.channels.has('yield:created')).toBe(true);
    expect(h.channels.has('yield:updated')).toBe(true);
    expect(h.channels.has('yield:representation-added')).toBe(true);
    expect(h.channels.has('mark:archived')).toBe(true);
    expect(h.channels.has('mark:added')).toBe(true);
    expect(h.channels.has('mark:removed')).toBe(true);

    stateUnit.dispose();
  });

  it('events$ merges all channels into typed SmelterEvents', async () => {
    const stateUnit = createSmelterActorStateUnit({ bus: h.bus });
    stateUnit.start();

    const collected = firstValueFrom(stateUnit.events$.pipe(take(2), toArray()));

    h.pushEvent('yield:created', { resourceId: 'r-1', storageUri: '/a/b' });
    h.pushEvent('mark:added', { resourceId: 'r-1', annotation: { id: 'a-1' } });

    const events = await collected;
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('yield:created');
    expect(events[0]!.resourceId).toBe('r-1');
    expect(events[1]!.type).toBe('mark:added');

    stateUnit.dispose();
  });

  it('start() is idempotent', () => {
    const stateUnit = createSmelterActorStateUnit({ bus: h.bus });
    stateUnit.start();
    stateUnit.start();
    expect(h.bus.addChannels).toHaveBeenCalledTimes(1);

    stateUnit.dispose();
  });
});
