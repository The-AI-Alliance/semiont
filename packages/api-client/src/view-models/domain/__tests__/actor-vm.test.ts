import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { createActorVM } from '../actor-vm';

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

describe('createActorVM', () => {
  let esInstance: ReturnType<typeof setupEventSource>['instance'];
  let esCalls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    const { instance, calls } = setupEventSource();
    esInstance = instance;
    esCalls = calls;
  });

  it('start connects to SSE with channel params', () => {
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['gather:requested', 'gather:cancelled'],
    });

    vm.start();

    expect(esCalls).toEqual([
      'http://localhost:4000/bus/subscribe?channel=gather%3Arequested&channel=gather%3Acancelled',
    ]);

    vm.dispose();
  });

  it('start includes scope param when provided', () => {
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['mark:added'],
      scope: 'res-123',
    });

    vm.start();

    expect(esCalls[0]).toContain('scope=res-123');

    vm.dispose();
  });

  it('on$ delivers typed events filtered by channel', async () => {
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['gather:requested', 'match:requested'],
    });

    vm.start();

    const gathered = firstValueFrom(
      vm.on$<{ resourceId: string }>('gather:requested'),
    );

    const handler = esInstance.listeners.get('bus-event')!;
    handler({ data: JSON.stringify({ channel: 'match:requested', payload: { id: 'other' } }) });
    handler({ data: JSON.stringify({ channel: 'gather:requested', payload: { resourceId: 'res-1' } }) });

    const result = await gathered;
    expect(result).toEqual({ resourceId: 'res-1' });

    vm.dispose();
  });

  it('on$ is multicast — multiple subscribers share the stream', async () => {
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    vm.start();

    const results1: unknown[] = [];
    const results2: unknown[] = [];
    const sub1 = vm.on$('test:event').subscribe((v) => results1.push(v));
    const sub2 = vm.on$('test:event').subscribe((v) => results2.push(v));

    const handler = esInstance.listeners.get('bus-event')!;
    handler({ data: JSON.stringify({ channel: 'test:event', payload: { n: 1 } }) });

    expect(results1).toEqual([{ n: 1 }]);
    expect(results2).toEqual([{ n: 1 }]);

    sub1.unsubscribe();
    sub2.unsubscribe();
    vm.dispose();
  });

  it('emit posts to /bus/emit with channel and payload', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
    });

    await vm.emit('gather:complete', { correlationId: 'c-1', context: {} });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4000/bus/emit',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          channel: 'gather:complete',
          payload: { correlationId: 'c-1', context: {} },
        }),
      }),
    );

    vm.dispose();
  });

  it('emit includes scope when set', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
      scope: 'res-42',
    });

    await vm.emit('mark:added', { annotationId: 'a-1' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.scope).toBe('res-42');

    vm.dispose();
  });

  it('connected$ reflects SSE state', async () => {
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    vm.start();

    const connPromise = firstValueFrom(vm.connected$.pipe(filter(Boolean)));
    esInstance.listeners.get('open')!();
    expect(await connPromise).toBe(true);

    vm.dispose();
  });

  it('stop closes EventSource and emits disconnected', () => {
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    vm.start();
    vm.stop();

    expect(esInstance.close).toHaveBeenCalled();

    vm.dispose();
  });

  it('reconnects on SSE error', async () => {
    vi.useFakeTimers();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      reconnectMs: 100,
    });

    vm.start();
    expect(esCalls).toHaveLength(1);

    esInstance.listeners.get('error')!();

    expect(esInstance.close).toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(esCalls).toHaveLength(2);

    vm.dispose();
    vi.useRealTimers();
  });

  it('does not reconnect after stop', () => {
    vi.useFakeTimers();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      reconnectMs: 100,
    });

    vm.start();
    esInstance.listeners.get('error')!();
    vm.stop();

    vi.advanceTimersByTime(200);
    expect(esCalls).toHaveLength(1);

    vm.dispose();
    vi.useRealTimers();
  });
});
