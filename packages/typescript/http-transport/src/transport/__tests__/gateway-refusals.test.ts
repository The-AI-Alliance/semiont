/**
 * A refused client backs off by the gateway's clock, not its own. A 429 or
 * 503 from a limit carries `Retry-After`: an emit refused 429 waits at least
 * that long before its retry, and rejects `rate-limited` with the wait once
 * its budget is spent; a refused stream connect waits at least that long
 * before trying again; and reconnects asked for while a connect is still in
 * flight open one more stream, not one each — the overlap a principal's
 * stream limit counts stays bounded.
 *
 * One limit is not a wait: a 429 `refusal-rate` refuses the credential, as a
 * 401 does. It is renewed once and sent again at once, or fails
 * `unauthorized` with its 429; it is never waited out and sent again with the
 * token refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActorStateUnit } from '../actor-state-unit';
import type { APIError } from '../api-error';
import { mockConn, mockFetch } from './helpers/mock-conn';
import { annotationId } from '@semiont/core';

const baseUrl = 'http://localhost:4000';

function refusal(status: number, retryAfterSeconds: number, code: string) {
  const body = JSON.stringify({ error: 'refused', code });
  return {
    ok: false,
    status,
    statusText: status === 429 ? 'Too Many Requests' : 'Service Unavailable',
    headers: new Headers({ 'retry-after': String(retryAfterSeconds), 'content-type': 'application/json' }),
    body: null,
    text: async () => body,
  };
}

/** A refusal of the credential by the limit on refused requests, as a real response carries it: its body is read. */
function refusedCredential(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: 'refused', code: 'refusal-rate' }), {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'retry-after': String(retryAfterSeconds), 'content-type': 'application/json' },
  });
}

/** The bearer the `n`th request carried. */
const bearerOf = (n: number): string => (mockFetch.mock.calls[n]![1] as { headers: Record<string, string> }).headers['Authorization']!;

function accepted() {
  return { ok: true, status: 202, statusText: 'Accepted', headers: new Headers(), json: async () => ({ subscribers: 1 }) };
}

describe('refusals by the gateway\'s limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an emit refused 429 waits at least Retry-After before its retry', async () => {
    mockFetch.mockResolvedValueOnce(refusal(429, 3, 'emit-rate')).mockResolvedValueOnce(accepted());
    const actor = createActorStateUnit({ baseUrl, token: 'tok', channels: [] });
    const sent = actor.emit('beckon:hover', { annotationId: annotationId('a-1') });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(mockFetch, 'no retry before Retry-After').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await sent;
    actor.dispose();
  });

  it('an emit refused 429 past its retries rejects rate-limited, carrying the wait', async () => {
    mockFetch.mockResolvedValue(refusal(429, 3, 'emit-rate'));
    const actor = createActorStateUnit({ baseUrl, token: 'tok', channels: [] });
    const refused = expect(actor.emit('beckon:hover', { annotationId: annotationId('a-1') })).rejects.toMatchObject({
      code: 'rate-limited',
      status: 429,
      retryAfterMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await refused;
    actor.dispose();
  });

  it('a refused stream connect waits at least Retry-After before trying again', async () => {
    mockFetch.mockResolvedValueOnce(refusal(429, 20, 'streams'));
    mockConn();
    const actor = createActorStateUnit({ baseUrl, token: 'tok', channels: ['beckon:hover'] });
    actor.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockFetch, 'no reconnect before Retry-After').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    actor.dispose();
  });

  it('reconnects asked for while a connect is in flight open one more stream, not one each', async () => {
    mockConn();
    const actor = createActorStateUnit({ baseUrl, token: 'tok', channels: ['beckon:hover'] });
    actor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const inFlight = mockConn({ defer: true });
    mockConn();
    actor.addChannels(['beckon:focus']);
    await vi.advanceTimersByTimeAsync(150);
    expect(mockFetch, 'the first change connects').toHaveBeenCalledTimes(2);
    actor.addChannels(['beckon:sparkle']);
    await vi.advanceTimersByTimeAsync(150);
    actor.addChannels(['mark:added']);
    await vi.advanceTimersByTimeAsync(150);
    expect(mockFetch, 'the next changes wait for the connect in flight').toHaveBeenCalledTimes(2);

    inFlight.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch, 'one follow-up connect').toHaveBeenCalledTimes(3);
    const [, opts] = mockFetch.mock.calls[2] as [string, { body: string }];
    const global = (JSON.parse(opts.body) as { global: string[] }).global;
    expect(global, 'carrying every change').toEqual(expect.arrayContaining(['beckon:focus', 'beckon:sparkle', 'mark:added']));
    actor.dispose();
  });
});

describe('a refused credential is renewed, never waited out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an emit refused 429 refusal-rate is sent again at once with the renewed token, outside its budget', async () => {
    mockFetch.mockResolvedValueOnce(refusedCredential(3)).mockResolvedValueOnce(accepted());
    let token = 'tok';
    const refresher = vi.fn(async () => { token = 'fresh-tok'; return 'fresh-tok'; });
    const actor = createActorStateUnit({ baseUrl, token: () => token, channels: [], tokenRefresher: refresher });

    const sent = actor.emit('beckon:hover', { annotationId: annotationId('a-1') });
    await vi.advanceTimersByTimeAsync(10);
    await expect(sent, 'settled well inside the Retry-After').resolves.toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(bearerOf(0)).toBe('Bearer tok');
    expect(bearerOf(1)).toBe('Bearer fresh-tok');
    expect(refresher).toHaveBeenCalledTimes(1);
    actor.dispose();
  });

  it('an emit whose renewed token is refused too fails unauthorized with its 429, and is not sent a third time', async () => {
    mockFetch.mockImplementation(async () => refusedCredential(3));
    const refresher = vi.fn().mockResolvedValueOnce('fresh-tok').mockResolvedValueOnce('never-asked');
    const actor = createActorStateUnit({ baseUrl, token: 'tok', channels: [], tokenRefresher: refresher });

    const refused = expect(actor.emit('beckon:hover', { annotationId: annotationId('a-1') })).rejects.toMatchObject({
      code: 'unauthorized',
      status: 429,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await refused;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(refresher).toHaveBeenCalledTimes(1);
    actor.dispose();
  });

  it.each([
    ['gives no token', async () => null],
    ['gives the token refused', async () => 'tok'],
  ])('an emit whose refresher %s fails unauthorized, sent once', async (_what, refresher) => {
    mockFetch.mockImplementation(async () => refusedCredential(3));
    const actor = createActorStateUnit({ baseUrl, token: 'tok', channels: [], tokenRefresher: refresher });

    const refused = expect(actor.emit('beckon:hover', { annotationId: annotationId('a-1') })).rejects.toMatchObject({ code: 'unauthorized', status: 429 });
    await vi.advanceTimersByTimeAsync(60_000);
    await refused;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    actor.dispose();
  });

  it('without a refresher, an emit refused 429 refusal-rate is final at once: no retry after its Retry-After', async () => {
    mockFetch.mockImplementation(async () => refusedCredential(3));
    const actor = createActorStateUnit({ baseUrl, token: 'tok', channels: [] });

    const refused = expect(actor.emit('beckon:hover', { annotationId: annotationId('a-1') })).rejects.toMatchObject({ code: 'unauthorized', status: 429 });
    await vi.advanceTimersByTimeAsync(60_000);
    await refused;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    actor.dispose();
  });

  it('a stream refused 429 refusal-rate is reported unauthorized, parks, and opens at once with the renewed token', async () => {
    mockFetch.mockResolvedValueOnce(refusedCredential(20));
    mockConn();
    let token = 'tok';
    const refresher = vi.fn(async () => { token = 'fresh-tok'; return 'fresh-tok'; });
    const actor = createActorStateUnit({ baseUrl, token: () => token, channels: ['beckon:hover'], tokenRefresher: refresher });
    const reported: APIError[] = [];
    actor.errors$.subscribe((error) => reported.push(error));
    const states: string[] = [];
    actor.state$.subscribe((state) => states.push(state));

    actor.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ code: 'unauthorized', status: 429 });
    expect(states).toContain('unauthenticated');
    expect(mockFetch, 'opened again well inside the Retry-After').toHaveBeenCalledTimes(2);
    expect(bearerOf(1)).toBe('Bearer fresh-tok');
    expect(states.at(-1)).toBe('open');
    expect(refresher).toHaveBeenCalledTimes(1);
    actor.dispose();
  });
});
