/**
 * FaultyTransport sequenced replies (.plans/SDK-TESTING-DOUBLE.md, Phase 2).
 *
 * The division of labor the queue introduces: the fault SCHEDULE scripts the
 * WIRE (deliver / drop / delay / duplicate / reject-emit), the reply QUEUE
 * scripts the BACKEND (what each request that reaches it answers). So a
 * queued entry is consumed by every request the backend sees — including one
 * whose reply the wire then drops — and `duplicate-reply` replays the SAME
 * body twice, the way a duplicated wire frame carries one backend response.
 *
 * Replies are distinguished by `total` — a real field of the registry-typed
 * reply, so the assertions stay cast-free (`busRequest`'s return type is
 * inferred from the registry; a made-up shape would need a conversion the
 * type system rightly rejects).
 */

import { describe, it, expect } from 'vitest';
import { busRequest } from '../bus-request';
import { FaultyTransport } from '../faulty-transport';

const OP = 'browse:resources-requested';

describe('FaultyTransport.queueReply', () => {
  it('queued replies are consumed in FIFO order; an empty queue falls back to makeResponse', async () => {
    const transport = new FaultyTransport({
      makeResponse: () => ({ resources: [], total: 99, offset: 0 }),
    });
    transport.queueReply(OP, { resources: [], total: 1, offset: 0 });
    transport.queueReply(OP, { resources: [], total: 2, offset: 0 });

    const r1 = await busRequest(transport, OP, {});
    const r2 = await busRequest(transport, OP, {});
    const r3 = await busRequest(transport, OP, {});

    expect(r1.total).toBe(1);
    expect(r2.total).toBe(2);
    expect(r3.total).toBe(99);

    transport.dispose();
  });

  it('duplicate-reply replays ONE queued body twice — the queue models the backend, not the wire', async () => {
    const transport = new FaultyTransport({
      schedule: [{ kind: 'duplicate-reply' }, { kind: 'deliver' }],
      makeResponse: () => ({ resources: [], total: 99, offset: 0 }),
    });
    transport.queueReply(OP, { resources: [], total: 1, offset: 0 });
    transport.queueReply(OP, { resources: [], total: 2, offset: 0 });

    // busRequest takes the first matching reply; the duplicate is ignored by
    // correlation machinery, but it must NOT have consumed a second entry.
    const r1 = await busRequest(transport, OP, {});
    const r2 = await busRequest(transport, OP, {});

    expect(r1.total).toBe(1);
    expect(r2.total).toBe(2);

    transport.dispose();
  });

  it('drop-reply consumes the entry: the backend answered, the wire ate it', async () => {
    const transport = new FaultyTransport({
      schedule: [{ kind: 'drop-reply' }, { kind: 'deliver' }],
      makeResponse: () => ({ resources: [], total: 99, offset: 0 }),
    });
    transport.queueReply(OP, { resources: [], total: 1, offset: 0 });
    transport.queueReply(OP, { resources: [], total: 2, offset: 0 });

    // First request: reply dropped → bus.timeout at the small budget.
    await expect(busRequest(transport, OP, {}, 40)).rejects.toMatchObject({
      code: 'bus.timeout',
    });
    // Second request (a B14-shaped retry) sees the NEXT page, not a replay.
    const r2 = await busRequest(transport, OP, {}, 1_000);
    expect(r2.total).toBe(2);

    transport.dispose();
  });

  it('composes with the attach gate: no emit reaches the backend until state$ reports open', async () => {
    const transport = new FaultyTransport({
      makeResponse: () => ({ resources: [], total: 7, offset: 0 }),
    });
    transport.state$.next('connecting');

    const promise = busRequest(transport, OP, {}, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    // The gate held the emit: the backend saw nothing.
    expect(transport.requestLog).toHaveLength(0);

    transport.state$.next('open');
    const result = await promise;
    expect(result.total).toBe(7);
    expect(transport.requestLog).toHaveLength(1);

    transport.dispose();
  });
});

// ── SDK-TESTING-DOUBLE gap 6: payload assertions off the requestLog ──────
//
// A consumer asserting what its orchestrator actually SENT (envelope shape,
// gather options, job params) previously had to hand-roll a per-channel
// `transport.on(...)` wire recorder, because the log carried only accounting
// fields. The payload rides the entry now — one arrival-ordered surface.

describe('requestLog payloads', () => {
  it('carries the emitted payload on each entry, in arrival order', async () => {
    const transport = new FaultyTransport({ makeResponse: () => ({ resources: [], total: 0, offset: 0 }) });

    await busRequest(transport, OP, { limit: 10, entityType: 'Concept' }, 5_000);
    await busRequest(transport, OP, { limit: 25 }, 5_000);

    expect(transport.requestLog).toHaveLength(2);
    expect(transport.requestLog[0]!.payload).toMatchObject({ limit: 10, entityType: 'Concept' });
    expect(transport.requestLog[1]!.payload).toMatchObject({ limit: 25 });
    // The correlationId busRequest minted is on the payload too — the entry
    // is what went on the wire, not a cleaned copy.
    expect(transport.requestLog[0]!.payload.correlationId).toBe(transport.requestLog[0]!.correlationId);

    transport.dispose();
  });

  it('snapshots the payload — a later mutation of the caller object cannot rewrite history', async () => {
    const transport = new FaultyTransport({ makeResponse: () => ({ resources: [], total: 0, offset: 0 }) });

    const payload: Record<string, unknown> = { limit: 10 };
    await busRequest(transport, OP, payload, 5_000);
    payload.limit = 999;

    expect(transport.requestLog[0]!.payload.limit).toBe(10);

    transport.dispose();
  });

  it('logs the payload even when the wire eats the request (drop / reject)', async () => {
    const transport = new FaultyTransport({
      schedule: [{ kind: 'reject-emit' }],
      makeResponse: () => ({ resources: [], total: 0, offset: 0 }),
    });

    await expect(busRequest(transport, OP, { limit: 3 }, 50)).rejects.toThrow();

    // reject-emit never reached the backend, but the ATTEMPT is what a
    // consumer asserting "did we send it?" needs to see.
    expect(transport.requestLog).toHaveLength(1);
    expect(transport.requestLog[0]!.action.kind).toBe('reject-emit');
    expect(transport.requestLog[0]!.payload).toMatchObject({ limit: 3 });

    transport.dispose();
  });
});
