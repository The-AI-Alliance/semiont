import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
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
    // Reset timers in case a previous test left fake timers active and
    // then failed before calling vi.useRealTimers(). vitest does NOT
    // restore timers automatically on test failure; without this, a
    // leaked fake-timer regime silently breaks every subsequent real-
    // timer test in the file.
    vi.useRealTimers();
    // mockFetch's `mockResolvedValueOnce` / `mockImplementationOnce`
    // queues survive clearAllMocks, so reset them explicitly to give
    // each test a clean slate.
    mockFetch.mockReset();
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

  it('state$ transitions initial → connecting → open on successful start', async () => {
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const states: string[] = [];
    vm.state$.subscribe((s) => states.push(s));
    vm.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    expect(states[0]).toBe('initial');
    expect(states).toContain('connecting');
    expect(states[states.length - 1]).toBe('open');

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

  it('addChannels goes open → reconnecting → connecting → open', async () => {
    // Regression: abort-driven reconnects used to return early from the
    // connect loop on AbortError, skipping the disconnect signal. The
    // state machine formalizes the reconnect lifecycle: every reconnect
    // must visit `reconnecting` so observers (state-change handlers)
    // can react.
    mockSSEResponse();
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const states: string[] = [];
    vm.state$.subscribe((s) => states.push(s));

    vm.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    // Clear and observe only the transitions that follow addChannels.
    const openIdx = states.lastIndexOf('open');
    vm.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(states.lastIndexOf('open')).toBeGreaterThan(openIdx));

    const afterAddChannels = states.slice(openIdx + 1);
    expect(afterAddChannels).toContain('reconnecting');
    expect(afterAddChannels).toContain('connecting');
    expect(afterAddChannels[afterAddChannels.length - 1]).toBe('open');

    vm.dispose();
  });

  it('removeChannels also drives reconnecting → connecting → open', async () => {
    mockSSEResponse();
    mockSSEResponse();
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    vm.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const states: string[] = [];
    vm.state$.subscribe((s) => states.push(s));

    vm.removeChannels(['mark:added']);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(states.lastIndexOf('open')).toBeGreaterThan(states.indexOf('reconnecting')));

    expect(states).toContain('reconnecting');
    expect(states).toContain('connecting');
    expect(states[states.length - 1]).toBe('open');

    vm.dispose();
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

  // ── Connection-state machine ──────────────────────────────────────────

  it('stop() transitions state to `closed`', async () => {
    mockSSEResponse();
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const states: string[] = [];
    vm.state$.subscribe((s) => states.push(s));

    vm.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    vm.stop();
    expect(states[states.length - 1]).toBe('closed');

    vm.dispose();
  });

  it('enters `degraded` after staying in `reconnecting` past the threshold', { timeout: 10_000 }, async () => {
    // Uses real timers: fake-timer interaction with ReadableStream and
    // fetch mocks is fragile enough (the stream close propagates via a
    // real microtask) that a 3-ish-second real-time wait is the cleanest
    // way to exercise the degraded timer.
    const sse = mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      // Long enough that the retry timer doesn't fire during the wait;
      // we want to stay in `reconnecting`.
      reconnectMs: 10_000,
    });

    const states: string[] = [];
    vm.state$.subscribe((s) => states.push(s));

    vm.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    // Close the stream → reader.read returns done, while loop exits,
    // transition to `reconnecting`.
    sse.close();
    await vi.waitFor(() => expect(states).toContain('reconnecting'));

    // Wait ~3 real seconds for the degraded timer to fire.
    await new Promise((r) => setTimeout(r, 3_100));
    expect(states).toContain('degraded');

    vm.dispose();
  });

  it('invalid transition throws (e.g. stop() after stop() is a no-op, not a throw)', async () => {
    // The state machine is internal; the public API is stop()/dispose().
    // Assert that idempotent usage doesn't throw.
    mockSSEResponse();
    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });
    vm.start();
    vm.stop();
    expect(() => vm.stop()).not.toThrow();
    expect(() => vm.dispose()).not.toThrow();
  });

  // ── BUS-RESUMPTION.md behavior ────────────────────────────────────────

  it('tracks the last SSE id and sends it as Last-Event-ID on the next connect', async () => {
    const sse1 = mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['mark:added'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    // Server sends a persisted event with id: p-res-1-47
    sse1.push(
      'event: bus-event\nid: p-res-1-47\ndata: ' +
        JSON.stringify({ channel: 'mark:added', payload: { foo: 'bar' } }) +
        '\n\n',
    );
    // Give the parser a tick to process the frame.
    await Promise.resolve();
    await Promise.resolve();

    // Trigger a reconnect via addChannels.
    mockSSEResponse();
    vm.addChannels(['other:channel']);
    // RECONNECT_DEBOUNCE_MS = 100 in actor-vm; wait past it.
    await new Promise((r) => setTimeout(r, 120));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const initOpts = mockFetch.mock.calls[1][1] as { headers: Record<string, string> };
    expect(initOpts.headers['Last-Event-ID']).toBe('p-res-1-47');

    vm.dispose();
  });

  it('does not send Last-Event-ID header on the first connect', async () => {
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const initOpts = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(initOpts.headers['Last-Event-ID']).toBeUndefined();

    vm.dispose();
  });

  it('aborts previous in-flight fetch when a reconnect starts (orphan-stream fix)', async () => {
    // Regression: prior versions kept a single `abortController` slot,
    // so a rapid sequence of connect() calls could orphan earlier
    // fetches — their signals were replaced before they could be
    // aborted. Post-fix, every previous controller is aborted before a
    // new connect starts. Diagnosed from the suite-flake investigation
    // which captured 3 concurrent SSE subscribes in a single 8ms window.
    mockSSEResponse();

    const vm = createActorVM({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    vm.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const firstSignal = (mockFetch.mock.calls[0][1] as { signal: AbortSignal }).signal;
    expect(firstSignal.aborted).toBe(false);

    mockSSEResponse();
    vm.addChannels(['other:one']);
    await new Promise((r) => setTimeout(r, 150));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // First fetch's signal must now be aborted — the connect() that
    // produced the second fetch is responsible for aborting all prior
    // in-flight controllers.
    expect(firstSignal.aborted).toBe(true);

    // And the second fetch's signal is still live.
    const secondSignal = (mockFetch.mock.calls[1][1] as { signal: AbortSignal }).signal;
    expect(secondSignal.aborted).toBe(false);

    vm.dispose();
  });
});
