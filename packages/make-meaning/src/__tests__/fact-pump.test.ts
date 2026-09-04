/**
 * ARCHIVIST-STAYS-UP P5 — the fact pump.
 *
 * The Archivist republishes every persisted event onto the gateway bus so
 * projectors see it live. That pump is the leading hypothesis for the
 * load-correlated heap growth in `bugs/absent-archivist-wedges-browse.md`:
 * it fills at Stower's append rate and drains at HTTP round trips, with no
 * bound and no number saying how far behind it is.
 *
 * These tests pin two properties it did not have:
 *
 *   - the two emits for one event are CONCURRENT, not sequential — they are
 *     independent, and serialising them doubles drain time for nothing;
 *   - the backlog is OBSERVABLE, so "how far behind is the pump" is a number
 *     rather than an inference from RSS.
 *
 * What is deliberately NOT here: a bounded queue with a drop policy. The
 * plan's step 1 is to remove the need before designing for it — dropping
 * costs a projection that stays stale until its projector next restarts
 * (catch-up is a startup pass, verified in both `smelter-main` and
 * `weaver-main`). Measure first; the gauge below is what makes that possible.
 */

import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { Logger, StoredEvent } from '@semiont/core';
import { resourceId as makeResourceId, userId } from '@semiont/core';
import { createFactPump } from '../fact-pump';

const mockLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const settle = () => new Promise((r) => setImmediate(r));

function fact(seq: number, rid?: string): StoredEvent {
  return {
    id: `evt-${seq}`,
    type: 'mark:added',
    timestamp: new Date().toISOString(),
    userId: userId('did:web:example:users:alice'),
    version: 1,
    ...(rid ? { resourceId: makeResourceId(rid) } : {}),
    payload: {},
    metadata: { sequenceNumber: seq },
  } as unknown as StoredEvent;
}

describe('fact pump', () => {
  it('publishes an unscoped fact once', async () => {
    const emit = vi.fn(async () => 1);
    const facts$ = new Subject<StoredEvent>();
    const pump = createFactPump(facts$, { emit, logger: mockLogger });

    facts$.next(fact(1));
    await settle();

    expect(emit).toHaveBeenCalledTimes(1);
    pump.unsubscribe();
  });

  it('publishes a resource-scoped fact globally AND to its scope', async () => {
    const emit = vi.fn(async () => 1);
    const facts$ = new Subject<StoredEvent>();
    const pump = createFactPump(facts$, { emit, logger: mockLogger });

    facts$.next(fact(1, 'res-a'));
    await settle();

    expect(emit).toHaveBeenCalledTimes(2);
    const scopes = emit.mock.calls.map((c) => (c as unknown[])[2]);
    expect(scopes).toContain(undefined);
    expect(scopes).toContain('res-a');
    pump.unsubscribe();
  });

  it('issues the two emits CONCURRENTLY, not one after the other', async () => {
    // The defect: `await emit(global); await emit(scoped)` doubles the drain
    // time per event for no reason — the two are independent.
    let inFlight = 0;
    let peak = 0;
    const emit = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await settle();
      inFlight -= 1;
      return 1;
    });
    const facts$ = new Subject<StoredEvent>();
    const pump = createFactPump(facts$, { emit, logger: mockLogger });

    facts$.next(fact(1, 'res-a'));
    await settle();
    await settle();

    expect(peak).toBe(2);
    pump.unsubscribe();
  });

  it('reports its backlog — how far behind the pump is, as a number', async () => {
    // Without this the only symptom of a pump falling behind is RSS, which is
    // why the growth in the bug report is still a hypothesis.
    let release: (() => void) | undefined;
    const emit = vi.fn(() => new Promise<number>((res) => { release = () => res(1); }));
    const facts$ = new Subject<StoredEvent>();
    const pump = createFactPump(facts$, { emit, logger: mockLogger });

    expect(pump.depth()).toBe(0);
    facts$.next(fact(1));
    facts$.next(fact(2));
    facts$.next(fact(3));
    await settle();

    expect(pump.depth()).toBe(3);

    release?.();
    await settle();
    expect(pump.depth()).toBeLessThan(3);
    pump.unsubscribe();
  });

  it('keeps events in order — a later fact never overtakes an earlier one', async () => {
    // Guard on the concurrency change: parallelising the two emits of ONE
    // event must not parallelise events against each other.
    const seen: number[] = [];
    const emit = vi.fn(async (_c: unknown, payload: unknown) => {
      seen.push((payload as StoredEvent).metadata.sequenceNumber as number);
      await settle();
      return 1;
    });
    const facts$ = new Subject<StoredEvent>();
    const pump = createFactPump(facts$, { emit, logger: mockLogger });

    facts$.next(fact(1));
    facts$.next(fact(2));
    facts$.next(fact(3));
    for (let i = 0; i < 12; i++) await settle();

    expect(seen).toEqual([1, 2, 3]);
    pump.unsubscribe();
  });

  it('a failed publish is logged and the pump survives it', async () => {
    const emit = vi.fn()
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValue(1);
    const facts$ = new Subject<StoredEvent>();
    const pump = createFactPump(facts$, { emit, logger: mockLogger });

    facts$.next(fact(1));
    await settle();
    facts$.next(fact(2));
    await settle();

    expect(mockLogger.error).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(2);
    pump.unsubscribe();
  });
});
