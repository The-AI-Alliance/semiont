/**
 * Teeth for the liveness axioms (.plans/LIVENESS-AXIOMS.md, P1) — the same
 * discipline as state-unit-axioms.test.ts: before the harness is trusted
 * GREEN against real compositions (P2/P3), it must FAIL against
 * deliberately-broken doubles reconstructing the pre-fix behaviors from the
 * starvation incident (.plans/bugs/concurrent-browse-resource-starvation.md):
 *
 *   (a)  a no-retry cache double that swallows the rejection   → L2 (swallow)
 *   (a2) an unbounded-retry variant                            → L2 (budget)
 *   (a3) a swallow-into-pending-forever await variant          → L2 (settlement)
 *   (b)  a swallowed-contention double (the RETIRED single-slot
 *        scope contract, reproduced locally — the real transport
 *        composes since MULTI-RESOURCE-SCOPE)                  → L1
 *   (c)  an abort-at-handover connection double                → L3 (lost)
 *   (c2) a double-flush connection double                      → L3 (duplicate)
 *
 * Plus the does-not-cry-wolf positives: compliant doubles (retry once +
 * surface, drain at handover) stay green across generated fault schedules
 * and op interleavings.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Observable, Subject } from 'rxjs';
import { busRequest } from '../bus-request';
import { resourceId } from '../identifiers';
import { FaultyTransport } from '../faulty-transport';
import {
  assertLivenessAxioms,
  assertExactlyOnceDelivery,
  type DeliveryOp,
  type DeliverySubject,
} from '../liveness-axioms';

/** Small enough that a full drop→timeout→retry→timeout chain stays in ms. */
const TIMEOUT_MS = 10;
const OP = 'browse:resource-requested' as const;

// ── L1/L2 doubles ─────────────────────────────────────────────────────────

/**
 * The FIXED composition, reconstructed: a cold live-query that starts its
 * request on subscribe, acquires its resource's scope (scopes compose —
 * MULTI-RESOURCE-SCOPE), retries a faulted request once (B14), and surfaces
 * the final rejection as an error notification.
 */
function compliantQuery(transport: FaultyTransport, rid: string): Observable<unknown> {
  return new Observable((subscriber) => {
    transport.subscribeToResource(resourceId(rid));
    const attempt = (retriesLeft: number): void => {
      busRequest(transport, OP, { resourceId: rid }, TIMEOUT_MS)
        .then((v) => subscriber.next(v))
        .catch((err: unknown) => {
          if (retriesLeft > 0) attempt(retriesLeft - 1);
          else subscriber.error(err);
        });
    };
    attempt(1);
  });
}

/** (a) Pre-B14: the rejection is swallowed — no retry, no surfaced signal. */
function swallowingQuery(transport: FaultyTransport, rid: string): Observable<unknown> {
  return new Observable((subscriber) => {
    busRequest(transport, OP, { resourceId: rid }, TIMEOUT_MS)
      .then((v) => subscriber.next(v))
      .catch(() => { /* swallowed — the pre-fix catch(() => {}) */ });
  });
}

/** (a2) Retry storm: re-issues far past the sanctioned budget, then surfaces. */
function stormingQuery(transport: FaultyTransport, rid: string): Observable<unknown> {
  return new Observable((subscriber) => {
    const attempt = (issued: number): void => {
      busRequest(transport, OP, { resourceId: rid }, TIMEOUT_MS)
        .then((v) => subscriber.next(v))
        .catch((err: unknown) => {
          if (issued < 6) attempt(issued + 1);
          else subscriber.error(err);
        });
    };
    attempt(1);
  });
}

/** (b) Pre-fix scope handling, reproduced end-to-end inside the double: the
 * RETIRED single-slot contract (one distinct scope at a time — the real
 * transport composes since MULTI-RESOURCE-SCOPE) plus the pre-fix swallow of
 * its contention throw. The second distinct rid never issues its request —
 * that output starves, which is exactly what L1 must catch. */
function makeContentionStarvedQueries(transport: FaultyTransport, rids: readonly string[]): Observable<unknown>[] {
  let activeScope: string | null = null; // the old one-slot contract, local to the double
  return rids.map((rid) =>
    new Observable((subscriber) => {
      if (activeScope !== null && activeScope !== rid) {
        return; // contention swallowed; no request is ever issued
      }
      activeScope = rid;
      busRequest(transport, OP, { resourceId: rid }, TIMEOUT_MS)
        .then((v) => subscriber.next(v))
        .catch((err: unknown) => subscriber.error(err));
    }),
  );
}

// ── L3 doubles ────────────────────────────────────────────────────────────

/**
 * A connection-stream double with buffered (asynchronous) delivery. The mode
 * decides what a client-initiated transition does with the not-yet-delivered
 * buffer: `drain` flushes it first (the fix), `abort` discards it (pre-linger
 * defect 2), `duplicate` flushes every event twice (a dedup-failure stand-in).
 */
function connectionDouble(mode: 'drain' | 'abort' | 'duplicate'): DeliverySubject {
  const out = new Subject<string>();
  let buffer: string[] = [];
  const flush = (): void => {
    const pending = buffer;
    buffer = [];
    for (const id of pending) {
      out.next(id);
      if (mode === 'duplicate') out.next(id);
    }
  };
  return {
    write: (id) => { buffer.push(id); },
    transition: () => {
      if (mode === 'abort') buffer = []; // retire by abort: buffered events die
      else flush(); // retire by drain
    },
    output$: out.asObservable(),
    settle: async () => { flush(); }, // a live connection eventually delivers
  };
}

// ── The teeth ─────────────────────────────────────────────────────────────

describe('liveness axioms — the harness has teeth', () => {
  it(
    'passes a compliant retry-and-surface composition across generated schedules (does not cry wolf)',
    async () => {
      await assertLivenessAxioms({
        setup: (transport) => ({
          outputs: ['res-a', 'res-b'].map((rid) => compliantQuery(transport, rid)),
          // The await path: a caller that surfaces the rejection always settles.
          settlements: [
            busRequest(transport, OP, { resourceId: 'res-c' }, TIMEOUT_MS).catch(() => 'surfaced'),
          ],
        }),
        timeoutMs: TIMEOUT_MS,
      });
    },
    30_000,
  );

  it('(a) L2: a no-retry double that swallows the rejection is caught', async () => {
    await expect(
      assertLivenessAxioms({
        setup: (transport) => ({ outputs: [swallowingQuery(transport, 'res-a')] }),
        timeoutMs: TIMEOUT_MS,
        scheduleArb: fc.constant([{ kind: 'drop-reply' }] as const),
        numRuns: 3,
      }),
    ).rejects.toThrow(/^L2: .*rejection swallowed/s);
  });

  it('(a2) L2: an unbounded-retry double exceeds the pinned budget', async () => {
    await expect(
      assertLivenessAxioms({
        setup: (transport) => ({ outputs: [stormingQuery(transport, 'res-a')] }),
        timeoutMs: TIMEOUT_MS,
        scheduleArb: fc.constant([{ kind: 'drop-reply' }] as const),
        numRuns: 3,
      }),
    ).rejects.toThrow(/^L2: .*exceeds the retry budget/s);
  }, 15_000);

  it('(a3) L2: an await path swallowed into pending-forever is caught', async () => {
    await expect(
      assertLivenessAxioms({
        setup: (transport) => ({
          outputs: [],
          settlements: [
            busRequest(transport, OP, { resourceId: 'res-a' }, TIMEOUT_MS)
              // Pre-fix encoding of the forbidden fourth state: the rejection
              // is converted into a promise that never settles.
              .catch(() => new Promise(() => {})),
          ],
        }),
        timeoutMs: TIMEOUT_MS,
        scheduleArb: fc.constant([{ kind: 'drop-reply' }] as const),
        numRuns: 3,
      }),
    ).rejects.toThrow(/^L2: [\s\S]*settlement #0 did not settle/);
  });

  it('(b) L1: a swallowed-contention double (the retired single-slot contract) starves the second output', async () => {
    await expect(
      assertLivenessAxioms({
        setup: (transport) => ({
          outputs: makeContentionStarvedQueries(transport, ['res-a', 'res-b']),
        }),
        timeoutMs: TIMEOUT_MS,
        scheduleArb: fc.constant([{ kind: 'deliver' }] as const),
        numRuns: 3,
      }),
    ).rejects.toThrow(/^L1: [\s\S]*output #1 [\s\S]*silently pending/);
  });

  it('passes a drain-at-transition connection across generated interleavings (does not cry wolf)', async () => {
    await assertExactlyOnceDelivery({
      setup: () => connectionDouble('drain'),
    });
  });

  it('(c) L3: an abort-at-transition double loses the buffered event', async () => {
    await expect(
      assertExactlyOnceDelivery({
        setup: () => connectionDouble('abort'),
        opsArb: fc.constant(['write', 'transition'] as const satisfies readonly DeliveryOp[]),
        numRuns: 3,
      }),
    ).rejects.toThrow(/^L3: .*delivered 0 times.*lost across a transition/s);
  });

  it('(c2) L3: a double-flush double is caught as duplicate delivery', async () => {
    await expect(
      assertExactlyOnceDelivery({
        setup: () => connectionDouble('duplicate'),
        opsArb: fc.constant(['write'] as const satisfies readonly DeliveryOp[]),
        numRuns: 3,
      }),
    ).rejects.toThrow(/^L3: .*delivered 2 times.*duplicate/s);
  });
});
