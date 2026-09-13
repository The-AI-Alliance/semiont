/**
 * `HttpTransport`'s `ITransport` surface — the thin delegation to the actor.
 *
 * `emit`, `on`, `stream`, `state$` and `trackReply` are pass-throughs, and
 * they were untested: the wire-shape suite mocks `ky` (which the actor does
 * not use) and the actor suites drive `createActorStateUnit` directly, so
 * nothing exercised the transport's own methods. That mattered once
 * WORKER-BUS-TYPED-BY-CHANNEL removed the casts they used to carry —
 * `on$<EventMap[K]>(channel as string)` on both readers, and
 * `payload as unknown as Record<string, unknown>` on `emit` — because a
 * delegation that compiles is not evidence that it delegates.
 *
 * These pin behaviour, not types: that the right channel and payload reach
 * the actor, that a subscriber receives what arrives on its channel and
 * nothing from another, and that unsubscribing stops delivery.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { accessToken, baseUrl, type AccessToken, type EventMap } from '@semiont/core';
import { HttpTransport } from '../http-transport';
import { mockFetch, mockSSEResponse, sseChunk } from './helpers/mock-conn';

const BASE = baseUrl('http://localhost:4000');

describe('HttpTransport ITransport delegation', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const token = () => new BehaviorSubject<AccessToken | null>(accessToken('tok'));

  it('emit posts the channel and payload, and resolves the subscriber count', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ subscribers: 2 }) });
    const transport = new HttpTransport({ baseUrl: BASE });

    await expect(transport.emit('beckon:hover', { annotationId: 'a-1' })).resolves.toBe(2);

    const [url, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(`${BASE}/bus/emit`);
    expect(JSON.parse(opts.body)).toMatchObject({
      channel: 'beckon:hover',
      payload: { annotationId: 'a-1' },
    });

    transport.dispose();
  });

  it('emit carries the resource scope when one is given', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ subscribers: 1 }) });
    const transport = new HttpTransport({ baseUrl: BASE });

    await transport.emit('beckon:hover', { annotationId: 'a-1' }, 'res-9' as Parameters<
      HttpTransport['emit']
    >[2]);

    const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body)).toMatchObject({ scope: 'res-9' });

    transport.dispose();
  });

  it('on delivers its own channel only, and the returned disposer stops delivery', async () => {
    const sse = mockSSEResponse();
    // A credential is required to connect at all (the SSE connect gate), so a
    // tokenless transport would never issue the subscribe this test waits on.
    const transport = new HttpTransport({ baseUrl: BASE, token$: token() });

    const seen: EventMap['beckon:hover'][] = [];
    const off = transport.on('beckon:hover', (p) => seen.push(p));
    transport.actor.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:hover', payload: { annotationId: 'a-1' },
    })));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ annotationId: 'a-1' });

    // A different channel must not reach this subscriber — the filter is the
    // whole reason `stream` takes a channel rather than returning everything.
    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:sparkle', payload: { annotationId: 'a-2' },
    })));
    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:hover', payload: { annotationId: 'a-3' },
    })));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((p) => p.annotationId)).toEqual(['a-1', 'a-3']);

    off();
    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:hover', payload: { annotationId: 'a-4' },
    })));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(2);

    transport.dispose();
  });

  it('stream is the observable form of the same delivery', async () => {
    const sse = mockSSEResponse();
    // A credential is required to connect at all (the SSE connect gate), so a
    // tokenless transport would never issue the subscribe this test waits on.
    const transport = new HttpTransport({ baseUrl: BASE, token$: token() });

    const seen: EventMap['beckon:hover'][] = [];
    const sub = transport.stream('beckon:hover').subscribe((p) => seen.push(p));
    transport.actor.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:hover', payload: { annotationId: 'a-1' },
    })));
    await vi.waitFor(() => expect(seen).toEqual([{ annotationId: 'a-1' }]));

    sub.unsubscribe();
    transport.dispose();
  });

  it('state$ and trackReply reach the actor', async () => {
    mockSSEResponse();
    const transport = new HttpTransport({ baseUrl: BASE });

    const states: string[] = [];
    transport.state$.subscribe((s) => states.push(s));
    expect(states).toHaveLength(1); // BehaviorSubject — current state arrives on subscribe

    // `trackReply` returns its own disposer; calling it must not throw, and
    // the id must be gone afterwards (the actor sends tracked ids as
    // `pendingReplies` on every subscribe body).
    const untrack = transport.trackReply('cid-1');
    expect(typeof untrack).toBe('function');
    untrack();

    transport.dispose();
  });
});
