/**
 * FaultyTransport sequenced replies.
 *
 * The division of labor the queue introduces: the fault SCHEDULE scripts the
 * WIRE (deliver / drop / delay / duplicate / reject-emit), the reply QUEUE
 * scripts the GATEWAY (what each request that reaches it answers). So a
 * queued entry is consumed by every request the gateway sees — including one
 * whose reply the wire then drops — and `duplicate-reply` replays the SAME
 * body twice, the way a duplicated wire frame carries one gateway response.
 *
 * Replies are distinguished by `total` — a real field of the registry-typed
 * reply, so the assertions stay cast-free (`busRequest`'s return type is
 * inferred from the registry; a made-up shape would need a conversion the
 * type system rightly rejects).
 */

import { describe, it, expect } from 'vitest';
import { busRequest } from '../bus-request';
import { BUS_OPERATIONS, type BusOperationKey } from '../bus-operations';
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

  it('duplicate-reply replays ONE queued body twice — the queue models the gateway, not the wire', async () => {
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

  it('drop-reply consumes the entry: the gateway answered, the wire ate it', async () => {
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

  it('composes with the attach gate: no emit reaches the gateway until state$ reports open', async () => {
    const transport = new FaultyTransport({
      makeResponse: () => ({ resources: [], total: 7, offset: 0 }),
    });
    transport.state$.next('connecting');

    const promise = busRequest(transport, OP, {}, 5_000);
    await new Promise((r) => setTimeout(r, 20));
    // The gate held the emit: the gateway saw nothing.
    expect(transport.requestLog).toHaveLength(0);

    transport.state$.next('open');
    const result = await promise;
    expect(result.total).toBe(7);
    expect(transport.requestLog).toHaveLength(1);

    transport.dispose();
  });
});

// ── A reply that names what it answers for ───────────────────────────────
//
// Three replies state an id beside their `response`: the annotation or the
// resource a context was gathered for, the reference a search was for. A
// gateway takes it from the request, and so does the double: a test queues the
// response alone and the reply is whole.

describe('a reply that names what it answers for', () => {
  /** The payload of each reply frame `request` is answered with. */
  async function repliesTo(
    transport: FaultyTransport,
    op: BusOperationKey,
    request: Record<string, unknown>,
  ): Promise<unknown[]> {
    const replies: unknown[] = [];
    const heard = transport.frames(BUS_OPERATIONS[op].result).subscribe((frame) => replies.push(frame.payload));
    await busRequest(transport, op, request, 1_000);
    heard.unsubscribe();
    return replies;
  }

  it.each<[BusOperationKey, Record<string, unknown>, Record<string, unknown>]>([
    [
      'gather:requested',
      { annotationId: 'ann-1', resourceId: 'res-1' },
      { annotationId: 'ann-1', response: 'scripted' },
    ],
    [
      'gather:resource-requested',
      { resourceId: 'res-1', options: {} },
      { resourceId: 'res-1', response: 'scripted' },
    ],
    [
      'match:search-requested',
      { resourceId: 'res-1', referenceId: 'ann-1', context: {} },
      { referenceId: 'ann-1', response: 'scripted' },
    ],
  ])('the reply to %s states the id its request stated, beside the queued response', async (op, request, reply) => {
    const transport = new FaultyTransport();
    transport.queueReply(op, 'scripted');

    expect(await repliesTo(transport, op, request)).toStrictEqual([reply]);

    transport.dispose();
  });

  it('so does a reply makeResponse answers, and each copy of a duplicated one', async () => {
    const transport = new FaultyTransport({
      schedule: [{ kind: 'duplicate-reply' }],
      makeResponse: (op) => ({ for: op }),
    });

    const whole = { resourceId: 'res-1', response: { for: 'gather:resource-requested' } };
    expect(await repliesTo(transport, 'gather:resource-requested', { resourceId: 'res-1', options: {} })).toStrictEqual([
      whole,
      whole,
    ]);

    transport.dispose();
  });

  it('a reply that names nothing is its response and no more', async () => {
    const transport = new FaultyTransport();
    const page = { resources: [], total: 1, offset: 0 };
    transport.queueReply(OP, page);

    expect(await repliesTo(transport, OP, { limit: 10 })).toStrictEqual([{ response: page }]);

    transport.dispose();
  });

  it('a request that does not state what its reply names cannot be answered, and that is said', async () => {
    const transport = new FaultyTransport();
    transport.queueReply('gather:resource-requested', 'scripted');

    await expect(busRequest(transport, 'gather:resource-requested', { options: {} }, 1_000)).rejects.toThrow(
      'FaultyTransport: the reply to gather:resource-requested names "resourceId", which this request does not state',
    );

    transport.dispose();
  });
});

// ── Payload assertions off the requestLog ────────────────────────────────
//
// A consumer asserting what its orchestrator actually SENT (envelope shape,
// gather options, job params) reads it off the entry — one arrival-ordered
// surface — instead of hand-rolling a per-channel `transport.on(...)` wire
// recorder.

describe('requestLog payloads', () => {
  it('carries the emitted payload on each entry, in arrival order', async () => {
    const transport = new FaultyTransport({ makeResponse: () => ({ resources: [], total: 0, offset: 0 }) });

    await busRequest(transport, OP, { limit: 10, entityType: 'Concept' }, 5_000);
    await busRequest(transport, OP, { limit: 25 }, 5_000);

    expect(transport.requestLog).toHaveLength(2);
    expect(transport.requestLog[0]!.payload).toMatchObject({ limit: 10, entityType: 'Concept' });
    expect(transport.requestLog[1]!.payload).toMatchObject({ limit: 25 });
    // The key is NOT on the payload: it rides the envelope, and the log
    // records it as its own field. The entry is what went on the wire, and
    // the wire carries no routing metadata inside the message.
    expect(transport.requestLog[0]!.payload).not.toHaveProperty('correlationId');
    expect(transport.requestLog[0]!.correlationId).toEqual(expect.any(String));

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

    // reject-emit never reached the gateway, but the ATTEMPT is what a
    // consumer asserting "did we send it?" needs to see.
    expect(transport.requestLog).toHaveLength(1);
    expect(transport.requestLog[0]!.action.kind).toBe('reject-emit');
    expect(transport.requestLog[0]!.payload).toMatchObject({ limit: 3 });

    transport.dispose();
  });
});
