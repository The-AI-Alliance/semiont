/**
 * The catalog enumeration survives an archivist that has not connected yet.
 *
 * `browse:*` is answered by the archivist. A weaver that finishes authenticating
 * first asks a channel with no subscriber, and the gateway synthesizes a failure
 * — measured 3 s into a boot on 2026-09-09, both boot passes failing 12 ms apart
 * and giving up for the life of the process. The KB came up with an empty graph
 * behind a healthy `/health`, and live traffic then advanced the applied mark past
 * events that were never projected, leaving damage catch-up structurally cannot
 * repair.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BusRequestError, type BusRequestPrimitive } from '@semiont/core';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import { fetchCatalogPages } from '../catalog-pages';

/**
 * A bus whose reply to each page is scripted:
 *   - a page object → `browse:resources-result`
 *   - `null`        → the gateway's synthesized `code: 'peer-unavailable'`
 *   - `'refused'`   → an ordinary failure with no code (today's `bus.rejected`)
 */
type ScriptedReply = { resources: unknown[]; total: number } | null | 'refused';

function scriptedBus(replies: ScriptedReply[]) {
  const emitted: Record<string, unknown>[] = [];
  const failure = new Subject<Record<string, unknown>>();
  const result = new Subject<Record<string, unknown>>();
  let call = 0;

  const bus = {
    state$: new BehaviorSubject('open').asObservable(),
    emit: vi.fn(async (_channel: unknown, payload: unknown) => {
      const p = payload as Record<string, unknown>;
      emitted.push(p);
      const reply = replies[call++];
      queueMicrotask(() => {
        if (reply === null) {
          failure.next({
            correlationId: p.correlationId,
            code: 'peer-unavailable',
            message: 'No subscriber for browse:resources-requested: the service that answers it is not connected',
          });
        } else if (reply === 'refused') {
          failure.next({ correlationId: p.correlationId, message: 'permission denied' });
        } else {
          result.next({ correlationId: p.correlationId, response: reply });
        }
      });
      return 1;
    }),
    stream: vi.fn((channel: unknown) =>
      ((channel as string) === 'browse:resources-result' ? result : failure).asObservable() as unknown as Observable<never>,
    ),
  } as unknown as BusRequestPrimitive;

  return { bus, emitted };
}

const page = (n: number, total: number) => ({ resources: Array.from({ length: n }, (_, i) => ({ '@id': `r-${i}` })), total });

describe('fetchCatalogPages', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('retries a page whose answering service is not connected yet', async () => {
    vi.useFakeTimers();
    const { bus, emitted } = scriptedBus([null, null, page(2, 2)]);

    const pages = fetchCatalogPages(bus, { limit: 50 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pages).toHaveLength(2);
    expect(emitted).toHaveLength(3);
  });

  it('does NOT re-request a page that already succeeded', async () => {
    // The property that makes this per-REQUEST retry rather than per-pass, and
    // the reason it obeys SIDECAR-BOOT-RESILIENCE D3 instead of contradicting it:
    // re-running a whole pass to recover one refusal re-sends every emit that
    // already worked, which is the amplification that wedged the weaver.
    vi.useFakeTimers();
    const { bus, emitted } = scriptedBus([page(2, 4), null, page(2, 4)]);

    const pages = fetchCatalogPages(bus, { limit: 2 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pages).toHaveLength(4);
    // Three emits: page 1, the refused page 2, page 2 again — never page 1 twice.
    expect(emitted.map((e) => e.offset)).toEqual([0, 2, 2]);
  });

  it('gives up after the budget, so a genuinely absent peer still surfaces', async () => {
    // D4 is untouched: the error propagates and `runBootPass` logs and continues.
    // A retry that never gave up would trade this bug for a worse one.
    vi.useFakeTimers();
    const { bus } = scriptedBus(Array(20).fill(null));

    const rejects = expect(fetchCatalogPages(bus, { limit: 50 })).rejects.toThrow(/No subscriber/);
    await vi.advanceTimersByTimeAsync(120_000);
    await rejects;
  });

  it('passes `archived` only when the caller sets it', async () => {
    // The smelter excludes archived resources; the weaver projects them too. The
    // one difference between the two loops this replaced, preserved explicitly.
    const { bus: a, emitted: ea } = scriptedBus([page(0, 0)]);
    await fetchCatalogPages(a, { limit: 10, archived: false });
    expect(ea[0]).toMatchObject({ archived: false, limit: 10 });

    const { bus: b, emitted: eb } = scriptedBus([page(0, 0)]);
    await fetchCatalogPages(b, { limit: 500 });
    expect(eb[0]).not.toHaveProperty('archived');
  });

  it('does not retry a refusal — only a peer that has not connected', async () => {
    // `bus.rejected` is a command the answering service considered and refused.
    // Waiting does not change its mind, and spending the budget on it delays a
    // real error reaching the caller. The narrowness of `isPeerUnavailable` is
    // what keeps these apart.
    const { bus, emitted } = scriptedBus(['refused']);

    await expect(fetchCatalogPages(bus, { limit: 50 })).rejects.toBeInstanceOf(BusRequestError);
    expect(emitted).toHaveLength(1);
  });
});
