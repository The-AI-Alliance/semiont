/**
 * Regression: a one-shot `await` of a Browse live-query must REJECT when the
 * underlying bus request fails — it must not hang forever.
 *
 * Root cause (see .plans/SEMIONT-BUG-browse-annotations.md, "Link 3"): the
 * cache primitive's `doFetch` swallows fetch failures (CACHE-SEMANTICS B6 —
 * "fetch failure leaves the previous state intact") so that live-query
 * *subscribers* keep their stale value / stay in the loading state. That is
 * correct for the subscribe path. But the *await* path
 * (`CacheObservable.then` = first-non-undefined emission) then never sees a
 * value and never rejects — so `await client.browse.annotations(rId)` hangs
 * indefinitely when the result is lost on the wire, instead of surfacing the
 * `bus.timeout` / `bus.rejected` the busRequest already produced.
 *
 * The contract this pins:
 *   1. `await` of a Browse read REJECTS when the underlying fetch fails.
 *   2. `.subscribe(...)` of the same read sees `undefined` (loading) through
 *      the B14 retry chain — and when the chain EXHAUSTS on a key with no
 *      cached value, the subscriber is ERRORED (B15) rather than left on
 *      `undefined` forever. (Pre-B15 this file pinned "never errored"; the
 *      liveness axioms showed that to be L1's forbidden fourth state for
 *      value-less keys — see
 *      .plans/bugs/valueless-key-terminal-failure-starves-observers.md.
 *      Keys WITH a stale value keep B6 stale-beats-error: never errored.)
 *
 * No backend: a fake transport drives `busRequest` to a deterministic
 * failure-channel rejection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ITransport, ResourceId } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal `ITransport` stand-in exercising only what `busRequest` touches:
 * `emit(channel, payload)` and `stream(channel)`. `onEmit` lets a test react
 * to an outbound request; `push` injects a response onto the SAME subject the
 * transport's `stream(...)` hands back, so busRequest's subscriber receives it.
 */
function makeFakeTransport() {
  const subjects = new Map<string, Subject<Record<string, unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) {
      s = new Subject<Record<string, unknown>>();
      subjects.set(channel, s);
    }
    return s;
  };

  let onEmit: ((channel: string, payload: Record<string, unknown>) => void) | undefined;

  const transport = {
    baseUrl: 'http://test',
    emit: async (channel: string, payload: Record<string, unknown>) => {
      onEmit?.(channel, payload);
    },
    stream: (channel: string): Observable<Record<string, unknown>> =>
      subjectFor(channel).asObservable(),
    subscribeToResource: () => () => {},
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  };

  return {
    transport: transport as unknown as ITransport,
    setOnEmit: (f: (channel: string, payload: Record<string, unknown>) => void) => {
      onEmit = f;
    },
    push: (channel: string, payload: Record<string, unknown>) => subjectFor(channel).next(payload),
  };
}

const noopContent = {
  getBinary: async () => ({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
  getBinaryStream: async () => ({ stream: new ReadableStream(), contentType: 'text/plain' }),
  dispose: () => {},
} as unknown as IContentTransport;

describe('browse read — await semantics on fetch failure (Link 3)', () => {
  let bus: EventBus;
  let browse: BrowseNamespace;
  let setOnEmit: ReturnType<typeof makeFakeTransport>['setOnEmit'];
  let push: ReturnType<typeof makeFakeTransport>['push'];
  const rId: ResourceId = makeResourceId('res-1');

  beforeEach(() => {
    bus = new EventBus();
    const fake = makeFakeTransport();
    setOnEmit = fake.setOnEmit;
    push = fake.push;
    browse = new BrowseNamespace(fake.transport, bus, noopContent);

    // Every annotations request gets an immediate failure response on the
    // matching correlationId. busRequest subscribes to the failure stream
    // before emitting, so a synchronous push during emit is delivered.
    setOnEmit((channel, payload) => {
      if (channel === 'browse:annotations-requested') {
        push('browse:annotations-failed', {
          correlationId: payload.correlationId as string,
          message: 'boom',
        });
      }
    });
  });

  afterEach(() => {
    bus.destroy();
  });

  it('await rejects when the bus request fails (does not hang)', async () => {
    // Today the cache swallows the rejection → the await hangs → 'hung' (RED).
    // After the fix the await rejects → 'rejected' (GREEN).
    const outcome = await Promise.race([
      browse.annotations(rId).then(() => 'resolved', () => 'rejected'),
      delay(250).then(() => 'hung'),
    ]);

    expect(outcome).toBe('rejected');
  });

  it('subscribe on a value-less key: loading through the retry chain, then errored on exhaustion (B15)', async () => {
    const seen: Array<unknown> = [];
    const errors: unknown[] = [];
    const sub = browse.annotations(rId).subscribe({
      next: (v) => seen.push(v),
      error: (e) => errors.push(e),
    });

    await delay(50);
    sub.unsubscribe();

    // No value ever emitted (the store was never written — that half of B6
    // stands)…
    expect(seen).toEqual([undefined]);
    // …but the exhausted chain's terminal failure reached the subscriber as
    // an error notification (B15) — carrying the bus rejection, not silence.
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('boom');
  });
});
