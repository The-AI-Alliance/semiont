import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { createActorStateUnit } from '../actor-state-unit';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function sseChunk(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function sseChunkId(event: string, data: string, id: string): string {
  return `event: ${event}\nid: ${id}\ndata: ${data}\n\n`;
}

function createSSEStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return {
    stream,
    // Swallow enqueue/close after the stream has errored or closed. Aborting a
    // connection errors its stream; a test may still try to push to the now-
    // retired connection, and that should be a no-op rather than a throw.
    push: (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* errored/closed */ } },
    close: () => { try { controller.close(); } catch { /* already errored/closed */ } },
    error: (e: unknown) => { try { controller.error(e); } catch { /* already errored/closed */ } },
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

/**
 * A signal-honoring, optionally-deferred SSE connection mock. Unlike
 * `mockSSEResponse` (which ignores the abort signal), this errors its stream
 * when the connection's `AbortController` fires — faithfully reproducing how a
 * real `fetch(url, { signal })` cancels the response body. `defer: true` holds
 * the fetch promise unresolved until `open()` is called, so a test can observe
 * the window where a new connection is connecting-but-not-yet-open (the
 * make-before-break handoff). `aborted` reflects the captured signal.
 */
function mockConn({ defer = false }: { defer?: boolean } = {}) {
  const sse = createSSEStream();
  let capturedSignal: AbortSignal | undefined;
  let resolveFetch!: (r: unknown) => void;
  const fetchPromise = new Promise((res) => { resolveFetch = res; });
  const response = { ok: true, status: 200, body: sse.stream };
  mockFetch.mockImplementationOnce((_url: string, opts: { signal?: AbortSignal }) => {
    capturedSignal = opts.signal;
    if (capturedSignal) {
      capturedSignal.addEventListener('abort', () =>
        sse.error(new DOMException('Aborted', 'AbortError')),
      );
    }
    if (!defer) resolveFetch(response);
    return fetchPromise;
  });
  return {
    sse,
    open: () => resolveFetch(response),
    get aborted() { return capturedSignal?.aborted ?? false; },
  };
}

describe('createActorStateUnit', () => {
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

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['gather:requested', 'gather:cancelled'],
    });

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe(
      'http://localhost:4000/bus/subscribe?channel=gather%3Arequested&channel=gather%3Acancelled',
    );

    stateUnit.dispose();
  });

  it('addChannels with scope uses scoped param', async () => {
    mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['browse:resources-result'],
    });

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    mockSSEResponse();
    stateUnit.addChannels(['mark:added'], 'res-123');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('channel=browse%3Aresources-result');
    expect(url).toContain('scoped=mark%3Aadded');
    expect(url).toContain('scope=res-123');

    stateUnit.dispose();
  });

  it('on$ delivers typed events filtered by channel', async () => {
    const sse = mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['gather:requested', 'match:requested'],
    });

    stateUnit.start();

    const gathered = firstValueFrom(
      stateUnit.on$<{ resourceId: string }>('gather:requested'),
    );

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'match:requested', payload: { id: 'other' } })));
    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'gather:requested', payload: { resourceId: 'res-1' } })));

    const result = await gathered;
    expect(result).toEqual({ resourceId: 'res-1' });

    stateUnit.dispose();
  });

  it('on$ is multicast — multiple subscribers share the stream', async () => {
    const sse = mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const results1: unknown[] = [];
    const results2: unknown[] = [];
    const sub1 = stateUnit.on$('test:event').subscribe((v) => results1.push(v));
    const sub2 = stateUnit.on$('test:event').subscribe((v) => results2.push(v));

    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'test:event', payload: { n: 1 } })));

    await vi.waitFor(() => expect(results1).toHaveLength(1));

    expect(results1).toEqual([{ n: 1 }]);
    expect(results2).toEqual([{ n: 1 }]);

    sub1.unsubscribe();
    sub2.unsubscribe();
    stateUnit.dispose();
  });

  it('emit posts to /bus/emit with channel and payload', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
    });

    await stateUnit.emit('gather:complete', { correlationId: 'c-1', context: {} });

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

    stateUnit.dispose();
  });

  it('emit includes scope only when explicitly passed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({ ok: true });

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
      scope: 'res-42',
    });

    await stateUnit.emit('mark:added', { annotationId: 'a-1' });
    const unscoped = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(unscoped.scope).toBeUndefined();

    await stateUnit.emit('mark:added', { annotationId: 'a-2' }, 'res-99');
    const scoped = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(scoped.scope).toBe('res-99');

    stateUnit.dispose();
  });

  it('state$ transitions initial → connecting → open on successful start', async () => {
    mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));
    stateUnit.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    expect(states[0]).toBe('initial');
    expect(states).toContain('connecting');
    expect(states[states.length - 1]).toBe('open');

    stateUnit.dispose();
  });

  it('reassembles an event whose bytes span multiple reader.read() chunks', async () => {
    // Regression: the SSE parser's currentEvent/currentData/currentId
    // state used to be declared inside the read loop, so a large event
    // whose terminating blank line arrived in a later chunk was silently
    // dropped. This test pushes the event in pieces deliberately split
    // mid-data-line and mid-trailing-blank-line; the parser must hold
    // state across `reader.read()` calls.
    const sse = mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:big'],
    });

    const results: unknown[] = [];
    stateUnit.on$('test:big').subscribe((v) => results.push(v));
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const payload = { blob: 'x'.repeat(5000) };
    const frame = sseChunk('bus-event', JSON.stringify({ channel: 'test:big', payload }));

    // Split the frame into three chunks at points that fall inside the
    // data line and before the terminating "\n\n".
    const split1 = Math.floor(frame.length * 0.3);
    const split2 = Math.floor(frame.length * 0.7);
    sse.push(frame.slice(0, split1));
    sse.push(frame.slice(split1, split2));
    sse.push(frame.slice(split2));

    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toEqual(payload);

    stateUnit.dispose();
  });

  it('ignores ping events', async () => {
    const sse = mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const results: unknown[] = [];
    stateUnit.on$('test:event').subscribe((v) => results.push(v));

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('ping', ''));
    sse.push(sseChunk('bus-event', JSON.stringify({ channel: 'test:event', payload: { n: 1 } })));

    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results).toEqual([{ n: 1 }]);

    stateUnit.dispose();
  });

  it('reconnects when stream ends', async () => {
    vi.useFakeTimers();

    const sse1 = mockSSEResponse();
    mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      reconnectMs: 100,
    });

    stateUnit.start();

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    sse1.close();

    await vi.advanceTimersByTimeAsync(150);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    stateUnit.dispose();
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

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));

    stateUnit.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    // Clear and observe only the transitions that follow addChannels.
    const openIdx = states.lastIndexOf('open');
    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(states.lastIndexOf('open')).toBeGreaterThan(openIdx));

    const afterAddChannels = states.slice(openIdx + 1);
    expect(afterAddChannels).toContain('reconnecting');
    expect(afterAddChannels).toContain('connecting');
    expect(afterAddChannels[afterAddChannels.length - 1]).toBe('open');

    stateUnit.dispose();
  });

  it('removeChannels also drives reconnecting → connecting → open', async () => {
    mockSSEResponse();
    mockSSEResponse();
    mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));

    stateUnit.removeChannels(['mark:added']);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(states.lastIndexOf('open')).toBeGreaterThan(states.indexOf('reconnecting')));

    expect(states).toContain('reconnecting');
    expect(states).toContain('connecting');
    expect(states[states.length - 1]).toBe('open');

    stateUnit.dispose();
  });

  it('does not reconnect after stop', async () => {
    vi.useFakeTimers();

    mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      reconnectMs: 100,
    });

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    stateUnit.stop();

    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    stateUnit.dispose();
    vi.useRealTimers();
  });

  // ── Connection-state machine ──────────────────────────────────────────

  it('stop() transitions state to `closed`', async () => {
    mockSSEResponse();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));

    stateUnit.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    stateUnit.stop();
    expect(states[states.length - 1]).toBe('closed');

    stateUnit.dispose();
  });

  it('enters `degraded` after staying in `reconnecting` past the threshold', { timeout: 10_000 }, async () => {
    // Uses real timers: fake-timer interaction with ReadableStream and
    // fetch mocks is fragile enough (the stream close propagates via a
    // real microtask) that a 3-ish-second real-time wait is the cleanest
    // way to exercise the degraded timer.
    const sse = mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      // Long enough that the retry timer doesn't fire during the wait;
      // we want to stay in `reconnecting`.
      reconnectMs: 10_000,
    });

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));

    stateUnit.start();
    await vi.waitFor(() => expect(states).toContain('open'));

    // Close the stream → reader.read returns done, while loop exits,
    // transition to `reconnecting`.
    sse.close();
    await vi.waitFor(() => expect(states).toContain('reconnecting'));

    // Wait ~3 real seconds for the degraded timer to fire.
    await new Promise((r) => setTimeout(r, 3_100));
    expect(states).toContain('degraded');

    stateUnit.dispose();
  });

  it('recovers (does not crash) when a channel-set change fires while degraded (#844)', { timeout: 12_000 }, async () => {
    // Regression for #844: a channel-set change while `degraded` scheduled a
    // reconnect whose `degraded → reconnecting` transition the state machine
    // rejected — `transition()` threw from inside the reconnect timer, an
    // uncaught exception that killed the host process. The connection must
    // instead treat it as a legitimate recovery edge and head back to `open`.
    const sse1 = mockSSEResponse();
    mockSSEResponse(); // for the recovery reconnect

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      // Long, so the retry timer doesn't fire during the wait — we want to
      // sit in `reconnecting` long enough to cross the degraded threshold.
      reconnectMs: 10_000,
    });

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));

    // A listener keeps an uncaught throw from the buggy reconnect timer from
    // tearing down the test worker, and lets us assert it didn't happen.
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);

    try {
      stateUnit.start();
      await vi.waitFor(() => expect(states).toContain('open'));

      // Drop the stream → reconnecting, then wait past the degraded threshold.
      sse1.close();
      await vi.waitFor(() => expect(states).toContain('reconnecting'));
      await new Promise((r) => setTimeout(r, 3_100));
      expect(states).toContain('degraded');

      const fetchesBefore = mockFetch.mock.calls.length;

      // Channel-set change while degraded → schedules a reconnect.
      stateUnit.addChannels(['mark:added'], 'res-1');

      // Must attempt a reconnect (new fetch) and head back to `open` —
      // not throw a fatal `degraded → reconnecting`.
      await vi.waitFor(() => expect(states[states.length - 1]).toBe('open'), { timeout: 3_000 });
      expect(mockFetch.mock.calls.length).toBeGreaterThan(fetchesBefore);
      expect(uncaught.map((e) => e.message)).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      stateUnit.dispose();
    }
  });

  it('invalid transition throws (e.g. stop() after stop() is a no-op, not a throw)', async () => {
    // The state machine is internal; the public API is stop()/dispose().
    // Assert that idempotent usage doesn't throw.
    mockSSEResponse();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });
    stateUnit.start();
    stateUnit.stop();
    expect(() => stateUnit.stop()).not.toThrow();
    expect(() => stateUnit.dispose()).not.toThrow();
  });

  // ── BUS-RESUMPTION.md behavior ────────────────────────────────────────

  it('tracks the last SSE id and sends it as Last-Event-ID on the next connect', async () => {
    const sse1 = mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['mark:added'],
    });

    stateUnit.start();
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
    stateUnit.addChannels(['other:channel']);
    // RECONNECT_DEBOUNCE_MS = 100 in actor-state-unit; wait past it.
    await new Promise((r) => setTimeout(r, 120));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const initOpts = mockFetch.mock.calls[1][1] as { headers: Record<string, string> };
    expect(initOpts.headers['Last-Event-ID']).toBe('p-res-1-47');

    stateUnit.dispose();
  });

  it('does not send Last-Event-ID header on the first connect', async () => {
    mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const initOpts = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(initOpts.headers['Last-Event-ID']).toBeUndefined();

    stateUnit.dispose();
  });

  // ── #847 Phase 3: make-before-break reconnect ─────────────────────────

  it('retires the old connection only after the new one opens (make-before-break)', async () => {
    // Pre-#847 a scope-change reconnect aborted the live connection up front
    // (break-before-make), opening a gap in which an in-flight ephemeral
    // result was dropped. Now the old connection stays live until the new
    // fetch resolves, then is retired — and rapid connects still converge to
    // a single live stream (the orphan-stream guarantee).
    const c1 = mockConn();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Scope change → reconnect. The new connection is deferred: connecting,
    // not yet open.
    const c2 = mockConn({ defer: true });
    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // Make-before-break: while the new connection is still connecting, the
    // old one MUST remain live.
    expect(c1.aborted).toBe(false);

    // Once the new connection opens, the old is retired.
    c2.open();
    await vi.waitFor(() => expect(c1.aborted).toBe(true));

    stateUnit.dispose();
  });

  it('delivers an event arriving on the old connection during a scope change', async () => {
    // The gap that hung browse.* (#842/#843): a result emitted while the
    // connection was being swapped for a scope change was lost. With make-
    // before-break the old connection is still live and delivers it.
    const c1 = mockConn();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['browse:annotations-result'],
    });
    const received: unknown[] = [];
    stateUnit.on$('browse:annotations-result').subscribe((p) => received.push(p));
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const c2 = mockConn({ defer: true });
    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // New connection still connecting; the result arrives on the live old one.
    c1.sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'browse:annotations-result',
      payload: { correlationId: 'x', annotations: [] },
    })));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ correlationId: 'x', annotations: [] });

    // Let the handoff complete (old retired, new open) before teardown.
    c2.open();
    await vi.waitFor(() => expect(c1.aborted).toBe(true));
    stateUnit.dispose();
  });

  it('dedupes a persisted event delivered by both connections during the overlap', async () => {
    // During the handoff the same live persisted event can arrive on both
    // connections — its `p-*` id is stable across connections — so it must be
    // emitted to consumers exactly once.
    const c1 = mockConn();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['mark:added'],
    });
    const received: unknown[] = [];
    stateUnit.on$('mark:added').subscribe((p) => received.push(p));
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const c2 = mockConn({ defer: true });
    stateUnit.addChannels(['other:channel']);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const frame = sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'mark:added', payload: { seq: 1 } }),
      'p-res-1-1',
    );
    // Old connection delivers it.
    c1.sse.push(frame);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // New connection opens (old retired); it re-delivers the same id.
    c2.open();
    await vi.waitFor(() => expect(c1.aborted).toBe(true));
    c2.sse.push(frame);

    // Give the parser time to process the second frame; it must be deduped.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);

    stateUnit.dispose();
  });
});
