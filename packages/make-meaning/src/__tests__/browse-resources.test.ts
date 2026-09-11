/**
 * Listing resources survives an archivist that has not subscribed yet — the
 * startup race that left a KB with an empty graph behind a healthy `/health`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BusRequestError, type BusRequestPrimitive } from '@semiont/core';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import { browseAllResources, RESOURCE_LISTING_RETRY } from '../browse-resources';
import { retryBudgetMs, STARTUP_FETCH_RETRY } from '@semiont/core';
import { EMBEDDING_PROVIDER_RETRY, EMBED_ROUND_TRIP_TIMEOUT_MS } from '@semiont/vectors';

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

describe('listAllResources', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('retries a page whose answering service is not connected yet', async () => {
    vi.useFakeTimers();
    const { bus, emitted } = scriptedBus([null, null, page(2, 2)]);

    const pages = browseAllResources(bus, { limit: 50 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pages).toHaveLength(2);
    expect(emitted).toHaveLength(3);
  });

  it('does NOT re-request a page that already succeeded', async () => {
    // Per-request, not per-pass: a pass retry re-sends every page that worked.
    vi.useFakeTimers();
    const { bus, emitted } = scriptedBus([page(2, 4), null, page(2, 4)]);

    const pages = browseAllResources(bus, { limit: 2 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pages).toHaveLength(4);
    // Three emits: page 1, the refused page 2, page 2 again — never page 1 twice.
    expect(emitted.map((e) => e.offset)).toEqual([0, 2, 2]);
  });

  it('gives up after the budget, so a genuinely absent peer still surfaces', async () => {
    vi.useFakeTimers();
    const { bus } = scriptedBus(Array(20).fill(null));

    const rejects = expect(browseAllResources(bus, { limit: 50 })).rejects.toThrow(/No subscriber/);
    // Driven off the policy, not a literal: RESOURCE_LISTING_RETRY's budget grew from 39s
    // to ~6 min when it stopped borrowing STARTUP_FETCH_RETRY, and a hard-coded
    // advance would have silently stopped exercising the give-up path.
    await vi.advanceTimersByTimeAsync(retryBudgetMs(RESOURCE_LISTING_RETRY) * 2);
    await rejects;
  });

  it('passes `archived` only when the caller sets it', async () => {
    const { bus: a, emitted: ea } = scriptedBus([page(0, 0)]);
    await browseAllResources(a, { limit: 10, archived: false });
    expect(ea[0]).toMatchObject({ archived: false, limit: 10 });

    const { bus: b, emitted: eb } = scriptedBus([page(0, 0)]);
    await browseAllResources(b, { limit: 500 });
    expect(eb[0]).not.toHaveProperty('archived');
  });

  it('does not retry a refusal — only a peer that has not connected', async () => {
    // A refusal is not a delay — `isPeerUnavailable`'s narrowness keeps them apart.
    const { bus, emitted } = scriptedBus(['refused']);

    await expect(browseAllResources(bus, { limit: 50 })).rejects.toBeInstanceOf(BusRequestError);
    expect(emitted).toHaveLength(1);
  });
});

describe('RESOURCE_LISTING_RETRY outlasts an archivist boot', () => {
  it('is sized by a relationship, not a guess', () => {
    // The archivist's own boot retries twice — auth, then the embedding provider.
    // Waiting less means giving up on an archivist that is still starting.
    const archivistBoot =
      retryBudgetMs(STARTUP_FETCH_RETRY) +
      retryBudgetMs(EMBEDDING_PROVIDER_RETRY, EMBED_ROUND_TRIP_TIMEOUT_MS);

    expect(
      retryBudgetMs(RESOURCE_LISTING_RETRY),
      `RESOURCE_LISTING_RETRY (${Math.round(retryBudgetMs(RESOURCE_LISTING_RETRY) / 1000)}s) must outlast a ` +
        `worst-case archivist boot (${Math.round(archivistBoot / 1000)}s: auth + embedding ` +
        `provider). Raise RESOURCE_LISTING_RETRY, or shorten what the archivist waits for.`,
    ).toBeGreaterThan(archivistBoot);
  });

  it('does not borrow STARTUP_FETCH_RETRY, which is sized for the gateway', () => {
    expect(retryBudgetMs(RESOURCE_LISTING_RETRY)).toBeGreaterThan(retryBudgetMs(STARTUP_FETCH_RETRY));
  });
});
