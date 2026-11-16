/**
 * MULTI-RESOURCE-SCOPE Step 7 — the two-resources integration test the plan's
 * checklist names, over the REAL stack: `HttpTransport` → real
 * `ActorStateUnit` → mocked wire (mock-conn). The http-paths suite mocks the
 * actor to assert ref-counting via spies; this file is the one place the
 * composed behavior is pinned end-to-end:
 *
 *   - two `subscribeToResource` calls for DISTINCT resources produce ONE
 *     debounced reconnect whose POST body carries BOTH scoped entries;
 *   - a scoped SSE frame reaches a bridged local bus exactly once;
 *   - cleanup is independent — releasing one resource leaves the other's
 *     matrix entry intact (the removal rides the next addition's fast
 *     flush, so no lazy-timer knob is needed here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { EventBus, baseUrl, resourceId } from '@semiont/core';
import { mockFetch, mockSSEResponse, sseChunkId } from './helpers/mock-conn';
import { HttpTransport, RESOURCE_SCOPED_CHANNELS } from '../http-transport';

type MatrixBody = {
  global: string[];
  scoped: Array<{ scope: string; channels: string[]; lastEventId?: string }>;
};

/** Parse the POST body of the i-th /bus/subscribe fetch. */
const matrixOf = (callIndex: number): MatrixBody =>
  JSON.parse((mockFetch.mock.calls[callIndex]![1] as { body: string }).body) as MatrixBody;

describe('multi-scope over the real HttpTransport + ActorStateUnit', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
  });

  it('two resources subscribe onto one connection, events bridge once, cleanup is independent', async () => {
    mockSSEResponse(); // conn 1: the auto-start on token arrival
    const token$ = new BehaviorSubject<string | null>('tok');
    const transport = new HttpTransport({
      baseUrl: baseUrl('http://localhost:4000'),
      token$: token$ as never,
    });
    const bus = new EventBus();
    transport.bridgeInto(bus);

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(matrixOf(0).scoped).toEqual([]); // no scopes held yet

    // ── Two distinct resources inside one debounce window → ONE reconnect ─
    const sse2 = mockSSEResponse();
    const releaseA = transport.subscribeToResource(resourceId('res-A'));
    transport.subscribeToResource(resourceId('res-B'));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(mockFetch).toHaveBeenCalledTimes(2); // debounce collapsed both

    const matrix = matrixOf(1);
    const scopes = matrix.scoped.map((s) => s.scope).sort();
    expect(scopes).toEqual(['res-A', 'res-B']);
    for (const entry of matrix.scoped) {
      expect(entry.channels.sort()).toEqual([...RESOURCE_SCOPED_CHANNELS].sort());
    }

    // ── One scoped frame → exactly one delivery on the bridged bus ────────
    const received: unknown[] = [];
    bus.get('mark:added').subscribe((p) => received.push(p));
    sse2.push(sseChunkId(
      'bus-event',
      JSON.stringify({ channel: 'mark:added', payload: { seq: 1 }, scope: 'res-A' }),
      'p-res-A-1',
    ));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1); // once — not once per held scope

    // ── Independent cleanup: release A, add C → matrix is B + C ───────────
    mockSSEResponse();
    releaseA();
    transport.subscribeToResource(resourceId('res-C'));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    const after = matrixOf(2);
    expect(after.scoped.map((s) => s.scope).sort()).toEqual(['res-B', 'res-C']);
    // res-A's watermark survives its release for a later re-subscribe replay
    // — but its ENTRY is gone from the live matrix.
    expect(after.scoped.find((s) => s.scope === 'res-A')).toBeUndefined();

    transport.dispose();
    bus.destroy();
  });
});
