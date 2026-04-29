/**
 * createSmelterActorVM — unit tests.
 *
 * The VM takes a shared bus and attaches smelter-channel fan-in.
 * We fake the bus with a minimal object that exposes the three
 * methods the VM uses (`on$`, `emit`, `addChannels`) and drive
 * events through RxJS subjects. No HTTP or SSE involved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject, firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { createSmelterActorVM } from '../smelter-actor-vm';
import type { WorkerBus } from '@semiont/sdk';

function fakeBus() {
  const channels = new Set<string>();
  const streams = new Map<string, Subject<any>>();
  const emits: Array<{ channel: string; payload: any }> = [];

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
    emit: vi.fn(async (channel: string, payload: Record<string, unknown>) => {
      emits.push({ channel, payload });
    }),
  };

  return {
    bus,
    channels,
    pushEvent: (channel: string, payload: any) => getStream(channel).next(payload),
    emits,
  };
}

describe('createSmelterActorVM', () => {
  let h: ReturnType<typeof fakeBus>;

  beforeEach(() => {
    h = fakeBus();
  });

  it('extends the shared bus with all 6 smelter channels on start', () => {
    const vm = createSmelterActorVM({ bus: h.bus });
    vm.start();

    expect(h.channels.has('yield:created')).toBe(true);
    expect(h.channels.has('yield:updated')).toBe(true);
    expect(h.channels.has('yield:representation-added')).toBe(true);
    expect(h.channels.has('mark:archived')).toBe(true);
    expect(h.channels.has('mark:added')).toBe(true);
    expect(h.channels.has('mark:removed')).toBe(true);

    vm.dispose();
  });

  it('events$ merges all channels into typed SmelterEvents', async () => {
    const vm = createSmelterActorVM({ bus: h.bus });
    vm.start();

    const collected = firstValueFrom(vm.events$.pipe(take(2), toArray()));

    h.pushEvent('yield:created', { resourceId: 'r-1', storageUri: '/a/b' });
    h.pushEvent('mark:added', { resourceId: 'r-1', annotation: { id: 'a-1' } });

    const events = await collected;
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('yield:created');
    expect(events[0]!.resourceId).toBe('r-1');
    expect(events[1]!.type).toBe('mark:added');

    vm.dispose();
  });

  it('emit delegates to the bus', async () => {
    const vm = createSmelterActorVM({ bus: h.bus });
    await vm.emit('smelter:indexed', { resourceId: 'r-1' });

    expect(h.emits).toEqual([
      { channel: 'smelter:indexed', payload: { resourceId: 'r-1' } },
    ]);

    vm.dispose();
  });

  it('start() is idempotent', () => {
    const vm = createSmelterActorVM({ bus: h.bus });
    vm.start();
    vm.start();
    expect(h.bus.addChannels).toHaveBeenCalledTimes(1);

    vm.dispose();
  });
});
