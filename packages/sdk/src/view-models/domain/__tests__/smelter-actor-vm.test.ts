import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { createSmelterActorVM } from '../smelter-actor-vm';

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
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: sse.stream,
  });
  return sse;
}

describe('createSmelterActorVM', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to all 6 smelter-relevant event channels', async () => {
    mockSSEResponse();

    const vm = createSmelterActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('channel=yield%3Acreated');
    expect(url).toContain('channel=yield%3Aupdated');
    expect(url).toContain('channel=yield%3Arepresentation-added');
    expect(url).toContain('channel=mark%3Aarchived');
    expect(url).toContain('channel=mark%3Aadded');
    expect(url).toContain('channel=mark%3Aremoved');

    vm.dispose();
  });

  it('events$ merges all channels into typed SmelterEvents', async () => {
    const sse = mockSSEResponse();

    const vm = createSmelterActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const collected = firstValueFrom(vm.events$.pipe(take(2), toArray()));

    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'yield:created', payload: { resourceId: 'r-1', storageUri: '/a/b' } })));
    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'mark:added', payload: { resourceId: 'r-1', annotation: { id: 'a-1' } } })));

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
