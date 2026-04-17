import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { createSmelterActorVM } from '../smelter-actor-vm';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function setupEventSource() {
  const listeners = new Map<string, Function>();
  const instance = {
    addEventListener: (event: string, handler: Function) => listeners.set(event, handler),
    close: vi.fn(),
    listeners,
  };
  const calls: string[] = [];
  function MockEventSource(this: unknown, url: string) {
    calls.push(url);
    Object.assign(this as Record<string, unknown>, instance);
  }
  vi.stubGlobal('EventSource', MockEventSource);
  return { instance, calls };
}

function emitBusEvent(
  es: ReturnType<typeof setupEventSource>['instance'],
  channel: string,
  payload: Record<string, unknown>,
) {
  const handler = es.listeners.get('bus-event')!;
  handler({ data: JSON.stringify({ channel, payload }) });
}

describe('createSmelterActorVM', () => {
  let esInstance: ReturnType<typeof setupEventSource>['instance'];
  let esCalls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    const { instance, calls } = setupEventSource();
    esInstance = instance;
    esCalls = calls;
  });

  it('subscribes to all 6 smelter-relevant event channels', () => {
    const vm = createSmelterActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
    });

    vm.start();

    const url = esCalls[0];
    expect(url).toContain('channel=yield%3Acreated');
    expect(url).toContain('channel=yield%3Aupdated');
    expect(url).toContain('channel=yield%3Arepresentation-added');
    expect(url).toContain('channel=mark%3Aarchived');
    expect(url).toContain('channel=mark%3Aadded');
    expect(url).toContain('channel=mark%3Aremoved');

    vm.dispose();
  });

  it('events$ merges all channels into typed SmelterEvents', async () => {
    const vm = createSmelterActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
    });

    vm.start();

    const collected = firstValueFrom(vm.events$.pipe(take(2), toArray()));

    emitBusEvent(esInstance, 'yield:created', { resourceId: 'r-1', storageUri: '/a/b' });
    emitBusEvent(esInstance, 'mark:added', { resourceId: 'r-1', annotation: { id: 'a-1' } });

    const events = await collected;
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('yield:created');
    expect(events[0].resourceId).toBe('r-1');
    expect(events[1].type).toBe('mark:added');

    vm.dispose();
  });

  it('emit delegates to ActorVM', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const vm = createSmelterActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
    });

    await vm.emit('smelter:indexed', { resourceId: 'r-1' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/bus/emit',
      expect.objectContaining({ method: 'POST' }),
    );

    vm.dispose();
  });
});
