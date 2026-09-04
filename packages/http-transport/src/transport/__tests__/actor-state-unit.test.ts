import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { createActorStateUnit } from '../actor-state-unit';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';
// The SSE/fetch harness lives in helpers/mock-conn.ts (shared with the
// liveness property suite). Importing it stubs the global fetch.
import {
  mockFetch,
  sseChunk,
  sseChunkId,
  mockSSEResponse,
  mockConn,
} from './helpers/mock-conn';

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

  // The connect wire shape (POST + subscription-matrix body) is pinned in
  // the 'multi-scope subscription matrix' describe at the bottom.

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

    const [url, opts] = mockFetch.mock.calls[0] as [string, { method?: string; body: string }];
    expect(url).toBe('http://localhost:4000/bus/emit');
    expect(opts.method).toBe('POST');
    // Parsed, not string-compared: the body gained `clientId` (the routing
    // address, CORRELATED-REPLY-ROUTING D1) and a key-order-sensitive
    // string match makes every future wire field a spurious failure here.
    expect(JSON.parse(opts.body)).toEqual({
      channel: 'gather:complete',
      payload: { correlationId: 'c-1', context: {} },
      clientId: expect.any(String),
    });

    stateUnit.dispose();
  });

  it('emit bounds the /bus/emit POST with a timeout signal (JOB-RESTART-SAFETY P7)', async () => {
    // An unresponsive gateway must not hang the caller's loop forever — the
    // transport-level bound behind the 2026-09-03 finalization hang. Pin that
    // the POST carries an AbortSignal (the emit deadline); without it, a
    // wedged gateway hangs every mark:create / job:complete indefinitely.
    mockFetch.mockResolvedValueOnce({ ok: true });
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
    });

    await stateUnit.emit('mark:added', { annotationId: 'a-1' });

    const [, opts] = mockFetch.mock.calls[0] as [string, { signal?: unknown }];
    expect(opts.signal).toBeInstanceOf(AbortSignal);

    stateUnit.dispose();
  });

  it('emit rejects (does not hang) when its timeout aborts the POST (P7)', async () => {
    // When the deadline fires, `AbortSignal.timeout` rejects the fetch with a
    // TimeoutError; the caller must receive that rejection — a job failure the
    // queue classifies transient — rather than an unsettled promise. (The
    // deadline itself is a native timer vitest's fake clock does not drive, so
    // this pins the propagation the deadline produces, and the pin above pins
    // that the deadline is wired.)
    mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
    });

    await expect(stateUnit.emit('mark:added', { annotationId: 'a-1' })).rejects.toThrow(/timed out/i);

    stateUnit.dispose();
  });

  // ── SSE-AUTH-RESILIENCE P1: don't ask without a credential ──────────
  // Shape A: a session that exhausts refresh pushes `null` to `token$`, and
  // HttpTransport renders that as `''`. The actor used to send
  // `Authorization: Bearer ` and retry forever — a guaranteed-failing request
  // generated on a timer, which is the 401 storm. A connect with no
  // credential cannot succeed, so it must not be attempted.

  it('makes NO request while it has no credential', async () => {
    vi.useFakeTimers();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: () => '',              // the shape `token$.getValue() ?? ''` produces
      channels: ['test:event'],
    });

    stateUnit.start();
    // Well past several reconnect cadences: still nothing on the wire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).not.toHaveBeenCalled();

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('connects as soon as a credential arrives — the gate waits, it does not give up', async () => {
    // The other half of the absence assertion above: without this, a gate that
    // NEVER connects would pass that test. Same actor, same getter, a token
    // appearing between ticks.
    vi.useFakeTimers();
    mockSSEResponse();
    let token = '';
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: () => token,
      channels: ['test:event'],
    });

    stateUnit.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockFetch).not.toHaveBeenCalled();

    token = 'fresh-tok';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(opts.headers['Authorization']).toBe('Bearer fresh-tok');

    stateUnit.dispose();
    vi.useRealTimers();
  });

  it('emit resolves with the subscriber count from the response body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ subscribers: 3 }) });

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
    });

    await expect(stateUnit.emit('mark:added', { annotationId: 'a-1' })).resolves.toBe(3);

    stateUnit.dispose();
  });

  it('emit resolves -1 when the body is absent or unreadable (older gateway ≠ empty room)', async () => {
    // A parse failure must NOT read as "nobody is listening": -1 (unknown,
    // matching the Go client) keeps an older gateway distinguishable from a
    // genuine zero-subscriber emit.
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('no body'); } });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
    });

    await expect(stateUnit.emit('mark:added', { annotationId: 'a-1' })).resolves.toBe(-1);
    await expect(stateUnit.emit('mark:added', { annotationId: 'a-2' })).resolves.toBe(-1);

    stateUnit.dispose();
  });

  it('emit REJECTS on a non-2xx response — a refused emit must not read as success', async () => {
    // The gateway 400s an emit that fails request validation (e.g. a
    // MatchSearchRequest whose embedded annotations are malformed —
    // .plans/bugs/match-search-hangs-on-neo4j-datetime-annotations.md).
    // Resolving `-1` here swallows the refusal: the busRequest caller keeps
    // waiting for a reply that can never come. bus-request.ts's contract
    // ("An emit rejection (e.g. /bus/emit 4xx) propagates to the caller")
    // requires the transport to reject.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"Bus emit validation failed"}',
    });

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
    });

    await expect(stateUnit.emit('match:search-requested', { correlationId: 'c-1' }))
      .rejects.toThrow(/400.*Bus emit validation failed/);

    stateUnit.dispose();
  });

  it('emit includes scope only when explicitly passed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    mockFetch.mockResolvedValueOnce({ ok: true });

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [],
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

  it('never reports `open` while the subscribe fetch is pending — open means the response is streaming', async () => {
    // The negative direction of the pin above, and the attach signal the
    // busRequest gate trusts (.plans/BUS-ATTACH-GATE.md, Phase 0): if the
    // actor ever claimed `open` before the subscribe response's reader
    // started, the gate would emit into a stream nobody is reading — the
    // exact loss it exists to prevent.
    const conn = mockConn({ defer: true });

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));
    stateUnit.start();

    // The fetch has been issued but deliberately not resolved. Give the
    // event loop time to surface any premature transition.
    await new Promise((r) => setTimeout(r, 20));
    expect(states).not.toContain('open');
    expect(states[states.length - 1]).toBe('connecting');

    conn.open();
    await vi.waitFor(() => expect(states).toContain('open'));

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

  it('reassembles a large frame delivered in many small chunks, and a chunk carrying several complete events', async () => {
    // Companion to the spanning test above, pinned against the segment-
    // accumulating line splitter (worker OOM, 2026-09-03): the old
    // `buffer += chunk; buffer.split('\n')` re-flattened the whole
    // accumulated buffer per read — O(frame²/chunk) large-string churn on
    // multi-MB reply frames. The splitter must (a) survive a data line
    // split across dozens of reads, including cuts exactly on '\n', and
    // (b) dispatch several complete events arriving inside ONE read.
    const sse = mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:big'],
    });

    const results: unknown[] = [];
    stateUnit.on$<{ n?: number; blob?: string }>('test:big').subscribe((v) => results.push(v));
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const payload = { blob: 'y'.repeat(50_000) };
    const frame = sseChunk('bus-event', JSON.stringify({ channel: 'test:big', payload }));
    // Many small slices; 599 is coprime with the frame length's structure,
    // so cuts land mid-line, on header boundaries, and inside the trailer.
    for (let i = 0; i < frame.length; i += 599) {
      sse.push(frame.slice(i, i + 599));
    }
    // A boundary exactly on the newline that terminates the data line.
    const two = sseChunk('bus-event', JSON.stringify({ channel: 'test:big', payload: { n: 1 } }));
    const cut = two.indexOf('\n', two.indexOf('data: ')) + 1;
    sse.push(two.slice(0, cut));
    sse.push(two.slice(cut));
    // Two complete events plus the head of a third in one read; the tail
    // of the third arrives separately.
    const third = sseChunk('bus-event', JSON.stringify({ channel: 'test:big', payload: { n: 2 } }));
    const fourth = sseChunk('bus-event', JSON.stringify({ channel: 'test:big', payload: { n: 3 } }));
    const fifth = sseChunk('bus-event', JSON.stringify({ channel: 'test:big', payload: { n: 4 } }));
    sse.push(third + fourth + fifth.slice(0, 10));
    sse.push(fifth.slice(10));

    await vi.waitFor(() => expect(results).toHaveLength(5));
    expect(results[0]).toEqual(payload);
    expect(results.slice(1)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    stateUnit.dispose();
  });

  it('isSubscribed reflects the global channel set through add/removeChannels', () => {
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['job:claimed', 'job:claim-failed'],
    });

    expect(stateUnit.isSubscribed('job:claimed')).toBe(true);
    expect(stateUnit.isSubscribed('browse:annotations-result')).toBe(false);

    stateUnit.addChannels(['job:queued']);
    expect(stateUnit.isSubscribed('job:queued')).toBe(true);

    stateUnit.removeChannels(['job:queued']);
    expect(stateUnit.isSubscribed('job:queued')).toBe(false);

    // Scoped entries are NOT global subscriptions — replies never ride scopes.
    stateUnit.addChannels(['mark:added'], 'res-1');
    expect(stateUnit.isSubscribed('mark:added')).toBe(false);

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

  it('removeChannels also drives reconnecting → connecting → open (on the lazy cadence)', async () => {
    mockSSEResponse();
    mockSSEResponse();
    mockSSEResponse();

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
      lazyRemoveMs: 150,
    });

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));

    stateUnit.removeChannels(['mark:added'], 'res-1');
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

  // ── BUS-RESUMPTION.md / B17 behavior ──────────────────────────────────
  //
  // Watermark tracking, seeding, and persistence are per-scope now and
  // pinned in the 'multi-scope subscription matrix' describe at the
  // bottom. What stays here is the apply/stash ORDERING invariant.

  it('stashes an id only AFTER the event has been applied to on$ subscribers (the receive→apply gap)', async () => {
    // .plans/bugs/annotation-lost-on-immediate-reload-after-create.md: the
    // pre-fix loop ran saveLastEventId BEFORE the awaited apply fan-out.
    // Inside that await, a bystander cache's debounced save could fire,
    // find every cache quiet (nothing invalidated yet), and flush the
    // just-stashed bookmark — persisting an id whose event no cache had
    // absorbed. The invariant pinned here: by the instant saveLastEventId
    // runs, the event's subscribers have already run — so an id is only
    // ever stashable once its apply-effects are pending or done.
    const sse = mockSSEResponse();
    const order: string[] = [];

    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['mark:added'],
      saveLastEventId: () => order.push('stash'),
    });
    stateUnit.on$('mark:added').subscribe(() => order.push('apply'));

    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(
      'event: bus-event\nid: p-res-1-48\ndata: ' +
        JSON.stringify({ channel: 'mark:added', payload: { foo: 'bar' }, scope: 'res-1' }) +
        '\n\n',
    );

    await vi.waitFor(() => expect(order).toContain('stash'));
    expect(order).toEqual(['apply', 'stash']);

    stateUnit.dispose();
  });

  // ── #847 Phase 3: make-before-break reconnect ─────────────────────────

  it('retires the old connection only after the new one opens + the drain window (make-before-break + linger)', async () => {
    // Pre-#847 a scope-change reconnect aborted the live connection up front
    // (break-before-make), opening a gap in which an in-flight ephemeral
    // result was dropped. Now the old connection stays live until the new
    // fetch resolves, then LINGERS for LINGER_MS (draining buffered replies)
    // before being aborted — and rapid connects still converge to a single
    // live stream (the orphan-stream guarantee).
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

    // Once the new connection opens, the old lingers (still draining)…
    c2.open();
    await new Promise((r) => setTimeout(r, 50));
    expect(c1.aborted).toBe(false);

    // …and is aborted after the drain window — no connection leak.
    await vi.waitFor(() => expect(c1.aborted).toBe(true), { timeout: 2_500 });

    stateUnit.dispose();
  });

  it('a lingering connection ending naturally does not restart the reconnect machinery', async () => {
    // During the drain window the superseded connection may end on its own
    // (server teardown). That is expected — it must not transition the actor
    // to `reconnecting` or schedule a retry connect for the live stream.
    const c1 = mockConn();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['test:event'],
    });
    const states: string[] = [];
    stateUnit.state$.subscribe((s) => states.push(s));
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const c2 = mockConn({ defer: true });
    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    c2.open();
    await vi.waitFor(() => expect(states[states.length - 1]).toBe('open'));

    // The lingering old connection ends naturally mid-drain.
    c1.sse.close();
    await new Promise((r) => setTimeout(r, 150));

    expect(states[states.length - 1]).toBe('open'); // no reconnecting blip
    expect(mockFetch).toHaveBeenCalledTimes(2); // no retry connect scheduled

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

    // Let the handoff complete (old retired after the drain window) before teardown.
    c2.open();
    await vi.waitFor(() => expect(c1.aborted).toBe(true), { timeout: 2_500 });
    stateUnit.dispose();
  });

  // ── Linger-drain: replies in flight on the old connection at handover ──
  // (.plans/bugs/concurrent-browse-resource-starvation.md — ask 1)

  it('delivers a reply still in flight on the old connection after the new one opens (linger-drain)', async () => {
    // The starvation repro: N browse requests issued on the unscoped
    // connection; their correlated results were written to the old socket
    // around the handover and discarded when the old connection was aborted
    // the instant the new fetch resolved (buffered-but-unread bytes are lost
    // on abort). The old connection must LINGER (keep draining) after
    // handover; the id-dedup absorbs the overlap.
    const c1 = mockConn();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['browse:resource-result'],
    });
    const received: unknown[] = [];
    stateUnit.on$('browse:resource-result').subscribe((p) => received.push(p));
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const c2 = mockConn({ defer: true });
    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // Handoff completes: the new connection opens.
    c2.open();
    await new Promise((r) => setTimeout(r, 20));

    // A correlated reply the gateway wrote to the old socket around the
    // handover arrives on the OLD connection — it must still be delivered.
    c1.sse.push(sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'browse:resource-result', payload: { correlationId: 'c-lost', response: {} } }),
      'e-browse:resource-result:c-lost',
    ));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ correlationId: 'c-lost' });

    stateUnit.dispose();
  });

  it('dedupes a deterministic-id reply delivered by both connections during the linger overlap', async () => {
    // The gateway stamps correlated replies with deterministic ephemeral ids
    // (`e-<channel>:<correlationId>`, routes/bus.ts) precisely so both
    // connections tag the same reply identically — one emission, not two.
    const c1 = mockConn();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['browse:resource-result'],
    });
    const received: unknown[] = [];
    stateUnit.on$('browse:resource-result').subscribe((p) => received.push(p));
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const c2 = mockConn({ defer: true });
    stateUnit.addChannels(['mark:added'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    c2.open();
    await new Promise((r) => setTimeout(r, 20));

    const frame = sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'browse:resource-result', payload: { correlationId: 'c-dup', response: {} } }),
      'e-browse:resource-result:c-dup',
    );
    c1.sse.push(frame);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    c2.sse.push(frame);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);

    stateUnit.dispose();
  });

  it('collapses connect + several scope-adds into a single swap (debounced batch)', async () => {
    // N scope-adds in one burst must produce ONE replacement connection,
    // not a swap per call.
    mockConn();
    const stateUnit = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['browse:resource-result'],
    });
    stateUnit.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    mockConn();
    stateUnit.addChannels(['mark:added'], 'res-1');
    stateUnit.addChannels(['mark:removed'], 'res-1');
    stateUnit.addChannels(['job:complete'], 'res-1');

    await new Promise((r) => setTimeout(r, 250));
    expect(mockFetch).toHaveBeenCalledTimes(2); // initial + exactly one swap

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

    // New connection opens (old retired after the drain window); it
    // re-delivers the same id.
    c2.open();
    await vi.waitFor(() => expect(c1.aborted).toBe(true), { timeout: 2_500 });
    c2.sse.push(frame);

    // Give the parser time to process the second frame; it must be deduped.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);

    stateUnit.dispose();
  });

  it('dedupes when both connections read the same frame CONCURRENTLY (no await between pushes)', async () => {
    // The sibling of the test above, and the case it cannot see: there the
    // duplicate arrives only after the first delivery has fully completed, so
    // `seenEventIds` is already populated whichever side of the awaited
    // fan-out the claim is recorded on. Here both read loops are handed the
    // same stable id with NO await in between, so they can both be inside the
    // fan-out await at once. If the dedup claim were recorded after that await
    // (the shape the fast-path reload fix introduced), both would find the set
    // empty and deliver — the overlap dedup defeated. See
    // .plans/bugs/BRIDGE-GAPS.md and PR #1077's review.
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
    c2.open();

    const frame = sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'mark:added', payload: { seq: 7 } }),
      'p-res-1-7',
    );
    // Both connections receive it with no yield in between — the overlap.
    c1.sse.push(frame);
    c2.sse.push(frame);

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);

    stateUnit.dispose();
  });
});

describe('ActorStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    // Constructed but never start()ed — the SSE/timer/reconnect machinery is
    // exercised by the suite above. Here we pin the lifecycle contract on the owned
    // `state$` (A5/A6/inert). `events$` is internal (reached via on$()), not a field.
    assertStateUnitAxioms({
      setup: () => createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: ['gather:requested'] }),
      surfaces: (u) => [u.state$],
    });
  });
});

// ── MULTI-RESOURCE-SCOPE Step 4: multi-scope subscription matrix ─────────

describe('multi-scope subscription matrix', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
  });

  type MatrixBody = {
    global: string[];
    scoped: Array<{ scope: string; channels: string[]; lastEventId?: string }>;
    clientId: string;
  };
  const bodyOf = (callIndex: number): MatrixBody =>
    JSON.parse((mockFetch.mock.calls[callIndex]![1] as { body: string }).body) as MatrixBody;

  it('connects via POST with the subscription matrix body (no query params, no Last-Event-ID header)', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['gather:requested'],
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [url, opts] = mockFetch.mock.calls[0] as [string, { method?: string; body?: string; headers: Record<string, string> }];
    expect(url).toBe('http://localhost:4000/bus/subscribe');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body!)).toEqual({
      global: ['gather:requested'],
      scoped: [],
      // CORRELATED-REPLY-ROUTING D1: the routing address rides every
      // subscribe. Matched loosely here — its stability is pinned below.
      clientId: expect.any(String),
    });
    expect(opts.headers['Last-Event-ID']).toBeUndefined();

    su.dispose();
  });

  it('two scope additions inside the debounce window → ONE reconnect carrying BOTH scopes', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['global:ch'],
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    mockSSEResponse();
    su.addChannels(['mark:added'], 'res-A');
    su.addChannels(['mark:added'], 'res-B'); // pre-fix: silently overwrote activeScope
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    // Debounce collapsed both into one reconnect; no third follows.
    await new Promise((r) => setTimeout(r, 200));
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const body = bodyOf(1);
    expect(body.global).toEqual(['global:ch']);
    expect(body.scoped).toHaveLength(2);
    expect(body.scoped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'res-A', channels: ['mark:added'] }),
        expect.objectContaining({ scope: 'res-B', channels: ['mark:added'] }),
      ]),
    );

    su.dispose();
  });

  it('scope removals alone reconnect LAZILY (hysteresis) — not on the fast debounce', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['global:ch'],
      lazyRemoveMs: 300,
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    mockSSEResponse();
    su.addChannels(['mark:added'], 'res-A');
    su.addChannels(['mark:added'], 'res-B');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    mockSSEResponse();
    su.removeChannels(['mark:added'], 'res-A');
    // Fast debounce window passes with NO reconnect — removal is lazy.
    await new Promise((r) => setTimeout(r, 150));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The lazy window elapses — now the reconnect fires, without res-A.
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3), { timeout: 1000 });
    const body = bodyOf(2);
    expect(body.scoped).toEqual([expect.objectContaining({ scope: 'res-B', channels: ['mark:added'] })]);

    su.dispose();
  });

  it('a pending removal is flushed by the next addition on the fast debounce', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['global:ch'],
      lazyRemoveMs: 5_000, // far away — the fast flush must carry the removal
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    mockSSEResponse();
    su.addChannels(['mark:added'], 'res-A');
    su.addChannels(['mark:added'], 'res-B');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    mockSSEResponse();
    su.removeChannels(['mark:added'], 'res-A');
    su.addChannels(['mark:added'], 'res-C');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    const body = bodyOf(2);
    const scopes = body.scoped.map((s) => s.scope).sort();
    expect(scopes).toEqual(['res-B', 'res-C']);

    su.dispose();
  });

  it('per-scope watermarks: a persisted frame updates its scope entry; ephemeral frames never do', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['global:ch'],
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const sse2 = mockSSEResponse();
    su.addChannels(['mark:added'], 'res-A');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    sse2.push(sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'mark:added', payload: { seq: 5 }, scope: 'res-A' }),
      'p-res-A-5',
    ));
    sse2.push(sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'mark:added', payload: {}, scope: 'res-A' }),
      'e-conn-9',
    ));
    await new Promise((r) => setTimeout(r, 20));

    mockSSEResponse();
    su.addChannels(['mark:added'], 'res-B');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

    const body = bodyOf(2);
    const entryA = body.scoped.find((s) => s.scope === 'res-A');
    const entryB = body.scoped.find((s) => s.scope === 'res-B');
    expect(entryA?.lastEventId).toBe('p-res-A-5'); // the e-* frame must not overwrite
    expect(entryB?.lastEventId).toBeUndefined();

    su.dispose();
  });

  it('loadLastEventIds seeds per-scope watermarks for later subscriptions (B17)', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['global:ch'],
      loadLastEventIds: () => ({ 'res-A': 'p-res-A-9' }),
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    mockSSEResponse();
    su.addChannels(['mark:added'], 'res-A');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const body = bodyOf(1);
    expect(body.scoped).toEqual([
      { scope: 'res-A', channels: ['mark:added'], lastEventId: 'p-res-A-9' },
    ]);

    su.dispose();
  });

  it('trackReply(cid) rides every connect body until released; empty set omits the field (BUS-RESUMPTION P2)', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['global:ch'],
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(bodyOf(0)).not.toHaveProperty('pendingReplies');

    const release = su.trackReply('cid-1');
    su.trackReply('cid-2');
    mockSSEResponse();
    su.addChannels(['mark:added'], 'res-A'); // trigger a reconnect
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect((bodyOf(1) as unknown as { pendingReplies: string[] }).pendingReplies.sort()).toEqual(['cid-1', 'cid-2']);

    release();
    release(); // idempotent — must not touch cid-2
    mockSSEResponse();
    su.addChannels(['mark:added'], 'res-B');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect((bodyOf(2) as unknown as { pendingReplies: string[] }).pendingReplies).toEqual(['cid-2']);

    su.dispose();
  });

  it('saveLastEventId receives (scope, id) per persisted frame — ephemeral ids are never saved (B17)', async () => {
    const saved: Array<[string, string]> = [];
    const sse = mockSSEResponse();
    const su = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['global:ch'],
      saveLastEventId: (scope, id) => saved.push([scope, id]),
    });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    sse.push(sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'mark:added', payload: { seq: 7 }, scope: 'res-A' }),
      'p-res-A-7',
    ));
    sse.push(sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'mark:added', payload: {}, scope: 'res-A' }),
      'e-conn-3',
    ));

    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));
    expect(saved).toEqual([['res-A', 'p-res-A-7']]);

    su.dispose();
  });

  // ── CORRELATED-REPLY-ROUTING P2: the routing address ────────────────────
  // D1: minted once per ACTOR, not per connection — a make-before-break
  // reconnect must present the same address, or the gateway's claim (P3)
  // stops matching the connection that carries the reply.

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('subscribes with a UUIDv4 clientId', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: ['global:ch'] });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    expect(bodyOf(0).clientId).toMatch(UUID_V4);
    su.dispose();
  });

  it('presents the SAME clientId across a reconnect — per actor, not per connection', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: ['global:ch'] });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // A scope addition forces a reconnect — the same path a make-before-break
    // handover takes, so this covers the overlap case D1 argues about.
    su.addChannels(['scoped:ch'], 'res-1');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // Assert presence before equality: two `undefined`s are equal, so a
    // bare toBe() would pass vacuously against a client that sends nothing.
    expect(bodyOf(0).clientId).toMatch(UUID_V4);
    expect(bodyOf(1).clientId).toBe(bodyOf(0).clientId);
    su.dispose();
  });

  it('two actors are two addresses', async () => {
    mockSSEResponse();
    const a = createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: ['global:ch'] });
    a.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const b = createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: ['global:ch'] });
    b.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    expect(bodyOf(1).clientId).not.toBe(bodyOf(0).clientId);
    a.dispose();
    b.dispose();
  });

  it('emit carries the same clientId, TOP-LEVEL — a wire field like scope, never inside payload', async () => {
    mockSSEResponse();
    const su = createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: ['global:ch'] });
    su.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const subscribed = bodyOf(0).clientId;

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ subscribers: 1 }) });
    await su.emit('mark:added', { annotationId: 'a-1' });

    const emitBody = JSON.parse((mockFetch.mock.calls[1]![1] as { body: string }).body) as
      { clientId?: string; payload: Record<string, unknown> };
    expect(subscribed).toMatch(UUID_V4);
    expect(emitBody.clientId).toBe(subscribed);
    expect(emitBody.payload).not.toHaveProperty('clientId');
    su.dispose();
  });

});
