/**
 * L3 — delivery across lifecycle transitions — over the REAL actor
 * (.plans/LIVENESS-AXIOMS.md, Phase 3).
 *
 * Property: every event written to a live connection's stream reaches `on$`
 * subscribers exactly once, wherever a scope-change handover lands relative
 * to the write. Retirement is by drain, never by handover abort
 * (docs/protocol/TRANSPORT-HTTP.md, Abort discipline).
 *
 * Teeth before trust: the property is first proven to FAIL against a
 * test-local double reconstructing the pre-fix behavior — defect 2 of the
 * starvation bug (.plans/bugs/concurrent-browse-resource-starvation.md):
 * a transition that errors the old stream immediately, so queued-but-unread
 * frames are discarded by `ReadableStreamDefaultController.error()` — the
 * exact byte-loss mechanism, reproduced at the stream level rather than
 * P1's abstract buffer double. Only then is the property trusted green
 * against the real `createActorStateUnit`.
 *
 * The hand-written linger/dedup tests in actor-state-unit.test.ts stay as
 * readable anchors; this property adds the interleavings nobody named.
 *
 * L4 (P4): the property describe silences `[bus LINGER]` (bursty, expected);
 * the dedicated L4 describe below asserts it — the gated breadcrumb fires for
 * a superseded-connection delivery once `busLogEnabled()` is on
 * (`globalThis.__SEMIONT_BUS_LOG__`, the existing switch), on the
 * deterministic linger-drain scenario borrowed from the hand-written anchor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { Subject, map } from 'rxjs';
import { assertExactlyOnceDelivery, type DeliverySubject, type DeliveryOp } from '@semiont/core/testing';
import { createActorStateUnit } from '../actor-state-unit';
import { mockFetch, mockConn, createSSEStream, sseChunkId } from './helpers/mock-conn';

const CHANNEL = 'browse:resource-result';

// ── The pre-fix double (teeth) ──────────────────────────────────────────────

/**
 * A minimal SSE read loop over the same ReadableStream mechanics the real
 * actor uses. `transition()` errors the live stream immediately — the pre-fix
 * abort, no drain. Because the glue issues consecutive ops synchronously, a
 * `write` directly followed by a `transition` leaves its frame queued-but-
 * unread, and `controller.error()` discards it: L3-lost, deterministically.
 */
function preFixAbortingConnection(): DeliverySubject {
  const out = new Subject<string>();

  function newConn() {
    const sse = createSSEStream();
    const reader = sse.stream.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
            if (idLine) out.next(idLine.slice(4));
          }
        }
      } catch {
        // Aborted — pre-fix semantics: whatever was queued is gone.
      }
    })();
    return { sse };
  }

  let current = newConn();
  return {
    write: (id) => current.sse.push(sseChunkId('bus-event', '{}', id)),
    transition: () => {
      current.sse.error(new DOMException('Aborted', 'AbortError')); // abort, no drain
      current = newConn();
    },
    output$: out.asObservable(),
    settle: () => new Promise((r) => setTimeout(r, 10)),
  };
}

// ── The real actor behind the DeliverySubject shape ─────────────────────────

/**
 * Adapts the real `createActorStateUnit` + the mockConn harness to
 * `DeliverySubject`. Fake timers are mandatory: `RECONNECT_DEBOUNCE_MS` (100)
 * and `LINGER_MS` (1000) are hardcoded, and fast-check runs many sequences.
 *
 * `write` pushes a deterministic-id frame to the newest OPENED connection —
 * during an initiated-but-unopened handover that is the OLD connection,
 * which is exactly the starvation race (results in flight on the old socket
 * when the swap lands).
 *
 * `transition` alternates: initiate a handover (scope churn → debounced
 * reconnect → deferred fetch, left unopened) / complete it (open the new
 * connection). The alternation is what makes generated sequences place
 * writes inside every phase of the handover window.
 */
function realActorSubject(): DeliverySubject {
  mockFetch.mockReset();

  const conns: ReturnType<typeof mockConn>[] = [];
  let liveIdx = 0; // newest OPENED connection
  let pendingIdx: number | null = null; // initiated handover, not yet open
  let churn = 0;

  conns.push(mockConn()); // conn 0 opens as soon as the actor connects
  const actor = createActorStateUnit({
    baseUrl: 'http://localhost:4000',
    token: 'tok',
    channels: [CHANNEL],
  });
  actor.start();

  return {
    write: (id) => {
      conns[liveIdx].sse.push(
        sseChunkId('bus-event', JSON.stringify({ channel: CHANNEL, payload: { id } }), `e-test:${id}`),
      );
    },
    transition: async () => {
      if (pendingIdx !== null) {
        // Complete the in-flight handover: the new connection opens; the old
        // one is superseded and lingers (drains) until LINGER_MS.
        conns[pendingIdx].open();
        liveIdx = pendingIdx;
        pendingIdx = null;
        await vi.advanceTimersByTimeAsync(5); // let the new read loop attach
      } else {
        // Initiate a handover: scope churn schedules a debounced reconnect.
        conns.push(mockConn({ defer: true }));
        pendingIdx = conns.length - 1;
        actor.addChannels(['mark:added'], `res-${churn++}`);
        const before = mockFetch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(150); // past RECONNECT_DEBOUNCE_MS
        if (mockFetch.mock.calls.length <= before) {
          throw new Error('adapter: debounced reconnect did not issue a new fetch');
        }
      }
    },
    settle: async () => {
      if (pendingIdx !== null) {
        conns[pendingIdx].open();
        liveIdx = pendingIdx;
        pendingIdx = null;
      }
      // Flush deliveries (reads are microtask-driven; advancing interleaves
      // them). Stays well below LINGER_MS so no linger abort races the flush.
      await vi.advanceTimersByTimeAsync(50);
    },
    teardown: () => actor.dispose(),
    output$: actor.on$<{ id: string }>(CHANNEL).pipe(map((p) => p.id)),
  };
}

// ── The tests ───────────────────────────────────────────────────────────────

describe('L3 — delivery across lifecycle transitions (liveness axioms P3)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
    // [bus LINGER] breadcrumbs fire on superseded-connection deliveries —
    // expected under this property. P4 flips this spy into the L4 assertion.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(console.debug).mockRestore();
  });

  it('teeth: the pre-fix abort-at-handover stream double trips L3-lost', async () => {
    await expect(
      assertExactlyOnceDelivery({
        setup: preFixAbortingConnection,
        // Pin the minimal losing interleaving (P1 teeth convention): the
        // write's frame is queued when the abort lands.
        opsArb: fc.constant(['write', 'write', 'transition'] as readonly DeliveryOp[]),
        numRuns: 3,
      }),
    ).rejects.toThrow(/^L3: .*delivered 0 times.*retire by drain, never by abort/s);
  });

  it('holds over the real actor across generated write/handover interleavings', async () => {
    vi.useFakeTimers();
    try {
      await assertExactlyOnceDelivery({
        setup: realActorSubject,
        maxOps: 10,
        numRuns: 25,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── L4 — observable degradation: the [bus LINGER] breadcrumb (liveness P4) ──

describe('L4 — [bus LINGER] fires for a superseded-connection delivery', () => {
  const busLogGlobal = globalThis as { __SEMIONT_BUS_LOG__?: boolean };

  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
    // Recording spy — the assertion surface. The breadcrumb is gated behind
    // busLogEnabled(); flip the existing runtime switch for this describe.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    // The gate also turns on busLog's RECV/SSE lines — keep them off stdout.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    busLogGlobal.__SEMIONT_BUS_LOG__ = true;
  });

  afterEach(() => {
    delete busLogGlobal.__SEMIONT_BUS_LOG__;
    vi.mocked(console.debug).mockRestore();
    vi.mocked(console.log).mockRestore();
  });

  it('a drain-window delivery emits the breadcrumb — degradation is never silent', async () => {
    // The linger-drain anchor scenario (actor-state-unit.test.ts): a reply
    // written to the OLD socket around the handover, delivered while that
    // connection is superseded and draining. L4 asserts the delivery leaves
    // a forensic trace — the exact evidence the starvation incident's
    // investigation lacked.
    const c1 = mockConn();
    const actor = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: [CHANNEL],
    });
    const received: unknown[] = [];
    actor.on$(CHANNEL).subscribe((p) => received.push(p));
    actor.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const c2 = mockConn({ defer: true });
    actor.addChannels(['mark:added'], 'res-l4');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // Handover completes; c1 is now superseded, draining.
    c2.open();
    await new Promise((r) => setTimeout(r, 20));

    c1.sse.push(sseChunkId(
      'bus-event',
      JSON.stringify({ channel: CHANNEL, payload: { correlationId: 'c-l4', response: {} } }),
      `e-${CHANNEL}:c-l4`,
    ));
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const debugs = vi.mocked(console.debug).mock.calls.map((c) => String(c[0]));
    expect(debugs.some((d) => d.includes(`[bus LINGER] ${CHANNEL} delivered on superseded connection`))).toBe(true);

    actor.dispose();
  });
});
