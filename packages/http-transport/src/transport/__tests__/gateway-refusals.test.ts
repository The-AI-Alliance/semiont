/**
 * A refused client backs off by the gateway's clock, not its own. A 429 or
 * 503 from a limit carries `Retry-After`: an emit refused 429 waits at least
 * that long before its retry, and rejects `rate-limited` with the wait once
 * its budget is spent; a refused stream connect waits at least that long
 * before trying again; and reconnects asked for while a connect is still in
 * flight open one more stream, not one each — the overlap a principal's
 * stream limit counts stays bounded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActorStateUnit } from '../actor-state-unit';
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
