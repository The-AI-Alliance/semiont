/**
 * RED (CLIENT-SUBSCRIPTION-MANIFEST P1, D1): a stream outside the
 * subscription set throws at the call, not never.
 *
 * `busRequest` already refuses an unsubscribed REPLY channel
 * (`bus.unsubscribed`, core `bus-request.ts`), because a timed-out reply was
 * once this bug. A plain `stream()` has no such guard: on 2026-09-16 a
 * worker's `stream('job:queued')` returned a healthy-looking observable that
 * could never fire, every worker sat idle, and the only tell was
 * `lastQueuedEventAt: null` on /health. Nothing threw; nothing logged.
 *
 * The contract asserted here: on a transport that HAS a subscription set,
 * consuming a channel outside it fails AT THE CALL, naming the channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BusRequestError, PERSISTED_EVENT_TYPES, BRIDGED_CHANNELS, RESOURCE_SCOPED_CHANNELS } from '@semiont/core';
import { createActorStateUnit } from '../actor-state-unit';
import { mockFetch, mockSSEResponse } from './helpers/mock-conn';

describe('stream() refuses a channel outside the subscription set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockFetch.mockReset();
  });

  it('throws bus.unsubscribed naming the channel and the fix', () => {
    mockSSEResponse();
    const actor = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      // A narrowed set, exactly as a worker composes one.
      channels: ['job:claimed', 'job:claim-failed'],
    });
    actor.start();

    // The 2026-09-16 outage, expressed: the frame is on the broker, this
    // connection will never carry it.
    let thrown: unknown;
    try {
      actor.stream('job:queued');
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'stream() on an unsubscribed channel must throw, not return a silent observable').toBeInstanceOf(
      BusRequestError,
    );
    const error = thrown as BusRequestError;
    expect(error.code).toBe('bus.unsubscribed');
    // Naming the channel is the whole point: the outage's cost was that
    // nothing said which channel was missing.
    expect(error.message).toContain('job:queued');
    expect(error.details).toMatchObject({ channel: 'job:queued' });

    actor.dispose();
  });

  it('allows a channel inside the set', async () => {
    const sse = mockSSEResponse();
    const actor = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['job:claimed'],
    });
    actor.start();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const seen: unknown[] = [];
    expect(() => actor.stream('job:claimed').subscribe((v) => seen.push(v))).not.toThrow();

    sse.push(
      `event: bus-event\ndata: ${JSON.stringify({ channel: 'job:claimed', payload: { jobId: 'j1' } })}\n\n`,
    );
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    actor.dispose();
  });

  it('accepts a channel added after construction — the set is live, not frozen at build', () => {
    mockSSEResponse();
    const actor = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['job:claimed'],
    });
    actor.start();

    expect(() => actor.stream('job:queued')).toThrow();
    actor.addChannels(['job:queued']);
    // The refusal reads the CURRENT set. Asserting this pins the check
    // against the live set rather than a constructor-time copy — P2 deletes
    // the widening call sites, and a frozen-at-build check would pass that
    // refactor while breaking anything still widening.
    expect(() => actor.stream('job:queued')).not.toThrow();

    actor.dispose();
  });

  it('does not refuse a SCOPED channel — scope subscriptions are a separate set', () => {
    mockSSEResponse();
    const actor = createActorStateUnit({
      baseUrl: 'http://localhost:4000',
      token: 'tok',
      channels: ['job:claimed'],
    });
    actor.start();

    // `isSubscribed` deliberately answers for the GLOBAL half only —
    // correlated replies always ride global channels. A refusal consulting
    // only that would break every scoped consumer. It must also pass BEFORE
    // any scope is joined: `HttpTransport.bridgeInto` subscribes every
    // scopable channel up front so frames flow the moment a scope arrives,
    // and asking the live scope entries would refuse the bridge its own
    // subscription (8 http-transport tests, measured 2026-09-16).
    const scoped = RESOURCE_SCOPED_CHANNELS.find(
      (c) => !(BRIDGED_CHANNELS as readonly string[]).includes(c),
    );
    if (!scoped) throw new Error('fixture assumes at least one scope-only channel exists');
    expect(PERSISTED_EVENT_TYPES as readonly string[]).toContain(scoped);

    // No scope joined yet — the bridge's case, and the one that broke.
    expect(() => actor.stream(scoped)).not.toThrow();

    actor.addChannels([scoped], 'res-1');
    expect(() => actor.stream(scoped)).not.toThrow();

    actor.dispose();
  });
});
