import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { createActorVM } from '../actor-vm';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function sseChunk(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function createSSEStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

function mockSSEResponse() {
  const sse = createSSEStream();
  const response = {
    ok: true,
    status: 200,
    body: sse.stream,
  };
  mockFetch.mockResolvedValueOnce(response);
  return sse;
}

describe('createActorVM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('start connects to SSE with channel params', async () => {
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['gather:requested', 'gather:cancelled'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe(
      'http://localhost:4000/bus/subscribe?channel=gather%3Arequested&channel=gather%3Acancelled',
    );

    vm.dispose();
  });

  it('addChannels with scope uses scoped param', async () => {
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['browse:resources-result'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    mockSSEResponse();
    vm.addChannels(['mark:added'], 'res-123');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('channel=browse%3Aresources-result');
    expect(url).toContain('scoped=mark%3Aadded');
    expect(url).toContain('scope=res-123');

    vm.dispose();
  });

  it('on$ delivers typed events filtered by channel', async () => {
    const sse = mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['gather:requested', 'match:requested'],
    });

    vm.start();

    const gathered = firstValueFrom(
      vm.on$<{ resourceId: string }>('gather:requested'),
    );

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'match:requested', payload: { id: 'other' } })));
    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'gather:requested', payload: { resourceId: 'res-1' } })));

    const result = await gathered;
    expect(result).toEqual({ resourceId: 'res-1' });

    vm.dispose();
  });

  it('on$ is multicast — multiple subscribers share the stream', async () => {
    const sse = mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const results1: unknown[] = [];
    const results2: unknown[] = [];
    const sub1 = vm.on$('test:event').subscribe((v) => results1.push(v));
    const sub2 = vm.on$('test:event').subscribe((v) => results2.push(v));

    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'test:event', payload: { n: 1 } })));

    await vi.waitFor(() => expect(results1).toHaveLength(1));

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

  it('emit includes scope only when explicitly passed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({ ok: true });

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
      scope: 'res-42',
    });

    await vm.emit('mark:added', { annotationId: 'a-1' });
    const unscoped = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(unscoped.scope).toBeUndefined();

    await vm.emit('mark:added', { annotationId: 'a-2' }, 'res-99');
    const scoped = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(scoped.scope).toBe('res-99');

    vm.dispose();
  });

  it('connected$ emits true on successful connect', async () => {
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const connPromise = firstValueFrom(vm.connected$.pipe(filter(Boolean)));
    vm.start();

    expect(await connPromise).toBe(true);

    vm.dispose();
  });

  it('ignores ping events', async () => {
    const sse = mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const results: unknown[] = [];
    vm.on$('test:event').subscribe((v) => results.push(v));

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('ping', ''));
    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'test:event', payload: { n: 1 } })));

    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results).toEqual([{ n: 1 }]);

    vm.dispose();
  });

  it('reconnects when stream ends', async () => {
    vi.useFakeTimers();

    const sse1 = mockSSEResponse();
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      reconnectMs: 100,
    });

    vm.start();

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    sse1.close();

    await vi.advanceTimersByTimeAsync(150);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    vm.dispose();
    vi.useRealTimers();
  });

  it('does not reconnect after stop', async () => {
    vi.useFakeTimers();

    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      reconnectMs: 100,
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    vm.stop();

    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vm.dispose();
    vi.useRealTimers();
  });
});
