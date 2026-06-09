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
 *   2. `.subscribe(...)` of the same read PRESERVES B6 — it sees `undefined`
 *      (loading) and is NOT errored. The fix must surface the failure to the
 *      awaiter WITHOUT erroring live-query subscribers.
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

  it('subscribe preserves SWR on fetch failure — stays undefined, not errored (B6)', async () => {
    const seen: Array<unknown> = [];
    let errored = false;
    const sub = browse.annotations(rId).subscribe({
      next: (v) => seen.push(v),
      error: () => {
        errored = true;
      },
    });

    await delay(50);
    sub.unsubscribe();

    expect(seen).toEqual([undefined]);
    expect(errored).toBe(false);
  });
});
