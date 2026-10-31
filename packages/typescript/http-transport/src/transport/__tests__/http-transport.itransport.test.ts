/**
 * `HttpTransport`'s `ITransport` surface — the thin delegation to the actor.
 *
 * `emit`, `on`, `stream`, `state$` and `trackReply` are pass-throughs that
 * no other suite reaches: the wire-shape suite mocks `ky` (which the actor
 * does not use) and the actor suites drive `createActorStateUnit` directly.
 * A delegation that compiles is not evidence that it delegates.
 *
 * These pin behaviour, not types: that the right channel and payload reach
 * the actor, that a subscriber receives what arrives on its channel and
 * nothing from another, and that unsubscribing stops delivery.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { accessToken, baseUrl, type AccessToken, type EventMap, annotationId, resourceId } from '@semiont/core';
import { HttpContentTransport } from '../http-content-transport';
import { HttpTransport, currentUserOf } from '../http-transport';
import { createSSEStream, mockFetch, mockSSEResponse, sseChunk } from './helpers/mock-conn';

const BASE = baseUrl('http://localhost:4000');

describe('HttpTransport ITransport delegation', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const token = () => new BehaviorSubject<AccessToken | null>(accessToken('tok'));

  it('emit posts the channel and payload, and resolves the subscriber count', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ subscribers: 2 }) });
    const transport = new HttpTransport({ baseUrl: BASE });

    await expect(transport.emit('beckon:hover', { annotationId: annotationId('a-1') })).resolves.toBe(2);

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

    await transport.emit('beckon:hover', { annotationId: annotationId('a-1') }, { scope: resourceId('res-9') });

    const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body)).toMatchObject({ scope: 'res-9' });

    transport.dispose();
  });

  // `beckon:focus`, not `beckon:hover`: these two tests assert SSE DELIVERY,
  // and the registry declares `beckon:hover` `inProcess` — it never crosses
  // the wire, so no gateway would ever send a frame on it, no default client
  // subscribes it, and `stream()` refuses it. `beckon:focus` is a
  // bridgedBroadcast and proves the filtering honestly.
  it('on delivers its own channel only, and the returned disposer stops delivery', async () => {
    const sse = mockSSEResponse();
    // A credential is required to connect at all (the SSE connect gate), so a
    // tokenless transport would never issue the subscribe this test waits on.
    const transport = new HttpTransport({ baseUrl: BASE, token$: token() });

    const seen: EventMap['beckon:focus'][] = [];
    const off = transport.on('beckon:focus', (p) => seen.push(p));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:focus', payload: { resourceId: 'res-1', annotationId: 'a-1' },
    })));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ resourceId: 'res-1', annotationId: 'a-1' });

    // A different channel must not reach this subscriber — the filter is the
    // whole reason `stream` takes a channel rather than returning everything.
    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:sparkle', payload: { annotationId: 'a-2' },
    })));
    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:focus', payload: { resourceId: 'res-1', annotationId: 'a-3' },
    })));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((p) => p.annotationId)).toEqual(['a-1', 'a-3']);

    off();
    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:focus', payload: { resourceId: 'res-1', annotationId: 'a-4' },
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

    const seen: EventMap['beckon:focus'][] = [];
    const sub = transport.stream('beckon:focus').subscribe((p) => seen.push(p));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    sse.push(sseChunk('bus-event', JSON.stringify({
      channel: 'beckon:focus', payload: { resourceId: 'res-1', annotationId: 'a-1' },
    })));
    await vi.waitFor(() => expect(seen).toEqual([{ resourceId: 'res-1', annotationId: 'a-1' }]));

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

describe('HttpTransport given its caller\'s fetch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** A fetch that answers as a gateway would, and records each request as `METHOD /path`. */
  function recordingFetch() {
    const asked: string[] = [];
    const sse = createSSEStream();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      asked.push(`${input instanceof Request ? input.method : (init?.method ?? 'GET')} ${url.pathname}`);
      if (url.pathname === '/bus/subscribe') return new Response(sse.stream, { headers: { 'content-type': 'text/event-stream' } });
      if (url.pathname === '/bus/emit') return Response.json({ subscribers: 1 });
      if (url.pathname === '/api/users/me') return Response.json({ did: 'did:web:kb.test:users:alice', email: null, name: null, image: null, domain: 'kb.test' });
      return new Response('the bytes', { headers: { 'content-type': 'text/plain' } });
    });
    return { asked, fetch };
  }

  it('sends its stream, its emits, its requests and its content through that fetch, and nothing through the runtime\'s', async () => {
    const given = recordingFetch();
    const transport = new HttpTransport({ baseUrl: BASE, token$: new BehaviorSubject<AccessToken | null>(accessToken('tok')), fetch: given.fetch });

    await vi.waitFor(() => expect(given.asked).toContain('POST /bus/subscribe'));
    await transport.emit('beckon:hover', { annotationId: annotationId('a-1') });
    await transport.getCurrentUser();
    await new HttpContentTransport(transport).getBinary(resourceId('res-1'));

    // The stream's connect is asked first; whether it is asked again is the stream's own business.
    expect(given.asked.filter((request) => request !== 'POST /bus/subscribe')).toEqual(['POST /bus/emit', 'GET /api/users/me', 'GET /resources/res-1']);
    expect(mockFetch).not.toHaveBeenCalled();
    transport.dispose();
  });

  it('currentUserOf asks through the fetch it is given', async () => {
    const given = recordingFetch();

    await currentUserOf(BASE, accessToken('tok'), given.fetch);

    expect(given.asked).toEqual(['GET /api/users/me']);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
