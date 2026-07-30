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
