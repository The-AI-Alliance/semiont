/**
 * FaultyTransport: sequenced replies, what a reader is given, and what
 * `errors$` keeps for its first reader.
 *
 * The division of labor the queue introduces: the fault SCHEDULE scripts the
 * WIRE (deliver / drop / delay / duplicate / reject-emit), the reply QUEUE
 * scripts the GATEWAY (what each request that reaches it answers). So a
 * queued entry is consumed by every request the gateway sees — including one
 * whose reply the wire then drops — and `duplicate-reply` replays the SAME
 * body twice, the way a duplicated wire frame carries one gateway response.
 *
 * Replies are distinguished by `total` — a real field of the registry-typed
 * reply, so the assertions stay cast-free (`Bus.request`'s return type is
 * inferred from the registry; a made-up shape would need a conversion the
 * type system rightly rejects).
 */

import { describe, it, expect } from 'vitest';
import type { Observable } from 'rxjs';
import { Bus } from '../bus';
import { BUS_OPERATIONS, type BusOperationKey } from '../bus-operations';
import { BRIDGED_CHANNELS } from '../bridged-channels';
import { EventBus } from '../event-bus';
import { SemiontError } from '../errors';
import { FaultyTransport } from '../faulty-transport';
import { ERRORS_KEPT_FOR_FIRST_READER_COUNT } from '../generated/client-timing';
import { annotationId, resourceId, userId, type ResourceId } from '../identifiers';
import type { EventMap } from '../bus-protocol';
import type { GatheredContext } from '../payload-types';
import type { components } from '../types';

const OP = 'browse:resources-requested';

/** A page of no resources, told apart from another by its `total`. */
const pageOf = (total: number): components['schemas']['ListResourcesResponse'] => ({ resources: [], total, offset: 0, limit: 10 });

describe('FaultyTransport.queueReply', () => {
  it('queued replies are consumed in FIFO order; an empty queue falls back to makeResponse', async () => {
    const transport = new FaultyTransport({
      channels: BRIDGED_CHANNELS,
      makeResponse: () => pageOf(99),
    });
    transport.queueReply(OP, pageOf(1));
    transport.queueReply(OP, pageOf(2));

    const r1 = await new Bus(transport).request(OP, {});
    const r2 = await new Bus(transport).request(OP, {});
    const r3 = await new Bus(transport).request(OP, {});

    expect(r1.total).toBe(1);
    expect(r2.total).toBe(2);
    expect(r3.total).toBe(99);

    transport.dispose();
  });

  it('duplicate-reply replays ONE queued body twice — the queue models the gateway, not the wire', async () => {
    const transport = new FaultyTransport({
      channels: BRIDGED_CHANNELS,
      schedule: [{ kind: 'duplicate-reply' }, { kind: 'deliver' }],
      makeResponse: () => pageOf(99),
    });
    transport.queueReply(OP, pageOf(1));
    transport.queueReply(OP, pageOf(2));

    // Bus.request takes the first matching reply; the duplicate is ignored by
    // correlation machinery, but it must NOT have consumed a second entry.
    const r1 = await new Bus(transport).request(OP, {});
    const r2 = await new Bus(transport).request(OP, {});

    expect(r1.total).toBe(1);
    expect(r2.total).toBe(2);

    transport.dispose();
  });

  it('drop-reply consumes the entry: the gateway answered, the wire ate it', async () => {
    const transport = new FaultyTransport({
      channels: BRIDGED_CHANNELS,
      schedule: [{ kind: 'drop-reply' }, { kind: 'deliver' }],
      makeResponse: () => pageOf(99),
    });
    transport.queueReply(OP, pageOf(1));
    transport.queueReply(OP, pageOf(2));

    // First request: reply dropped → bus.timeout at the small budget.
    await expect(new Bus(transport).request(OP, {}, 40)).rejects.toMatchObject({
      code: 'bus.timeout',
    });
    // Second request (a B14-shaped retry) sees the NEXT page, not a replay.
    const r2 = await new Bus(transport).request(OP, {}, 1_000);
    expect(r2.total).toBe(2);

    transport.dispose();
  });

  it('composes with the attach gate: no emit reaches the gateway until state$ reports open', async () => {
    const transport = new FaultyTransport({
      channels: BRIDGED_CHANNELS,
      makeResponse: () => pageOf(7),
    });
    transport.state$.next('connecting');

    const promise = new Bus(transport).request(OP, {}, 5_000);
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
    await new Bus(transport).request(op, request, 1_000);
    heard.unsubscribe();
    return replies;
  }

  const resource = { '@context': 'https://schema.org/', '@id': resourceId('res-1'), name: 'A resource', representations: [] };
  const context: GatheredContext = {
    focus: { kind: 'resource', resource },
    graph: { nodes: [], edges: [] },
    metadata: {},
  };
  const candidates: components['schemas']['ScoredResource'][] = [{ ...resource, score: 0.9, matchReason: 'the same name' }];

  it.each<[BusOperationKey, Record<string, unknown>, unknown, Record<string, unknown>]>([
    [
      'gather:requested',
      { annotationId: 'ann-1', resourceId: 'res-1' },
      context,
      { annotationId: 'ann-1', response: context },
    ],
    [
      'gather:resource-requested',
      { resourceId: 'res-1', options: {} },
      context,
      { resourceId: 'res-1', response: context },
    ],
    [
      'match:search-requested',
      { resourceId: 'res-1', referenceId: 'ann-1', context: {} },
      candidates,
      { referenceId: 'ann-1', response: candidates },
    ],
  ])('the reply to %s states the id its request stated, beside the queued response', async (op, request, response, reply) => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    transport.queueReply(op, response);

    expect(await repliesTo(transport, op, request)).toStrictEqual([reply]);

    transport.dispose();
  });

  it('so does a reply makeResponse answers, and each copy of a duplicated one', async () => {
    const transport = new FaultyTransport({
      channels: BRIDGED_CHANNELS,
      schedule: [{ kind: 'duplicate-reply' }],
      makeResponse: () => context,
    });

    const whole = { resourceId: 'res-1', response: context };
    expect(await repliesTo(transport, 'gather:resource-requested', { resourceId: 'res-1', options: {} })).toStrictEqual([
      whole,
      whole,
    ]);

    transport.dispose();
  });

  it('a reply that names nothing is its response and no more', async () => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    const page = pageOf(1);
    transport.queueReply(OP, page);

    expect(await repliesTo(transport, OP, { limit: 10 })).toStrictEqual([{ response: page }]);

    transport.dispose();
  });

  it('a request that does not state what its reply names cannot be answered, and that is said', async () => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    transport.queueReply('gather:resource-requested', 'scripted');

    await expect(new Bus(transport).request('gather:resource-requested', { options: {} }, 1_000)).rejects.toThrow(
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
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS, makeResponse: () => pageOf(0) });

    await new Bus(transport).request(OP, { limit: 10, entityType: 'Concept' }, 5_000);
    await new Bus(transport).request(OP, { limit: 25 }, 5_000);

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
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS, makeResponse: () => pageOf(0) });

    const payload: Record<string, unknown> = { limit: 10 };
    await new Bus(transport).request(OP, payload, 5_000);
    payload.limit = 999;

    expect(transport.requestLog[0]!.payload.limit).toBe(10);

    transport.dispose();
  });

  it('logs the payload even when the wire eats the request (drop / reject)', async () => {
    const transport = new FaultyTransport({
      channels: BRIDGED_CHANNELS,
      schedule: [{ kind: 'reject-emit' }],
      makeResponse: () => pageOf(0),
    });

    await expect(new Bus(transport).request(OP, { limit: 3 }, 50)).rejects.toThrow();

    // reject-emit never reached the gateway, but the ATTEMPT is what a
    // consumer asserting "did we send it?" needs to see.
    expect(transport.requestLog).toHaveLength(1);
    expect(transport.requestLog[0]!.action.kind).toBe('reject-emit');
    expect(transport.requestLog[0]!.payload).toMatchObject({ limit: 3 });

    transport.dispose();
  });
});

// ── What a reader is given ───────────────────────────────────────────────
//
// What a wire transport's stream carries, and no more: a frame of no scope on
// a channel the transport was given, and a frame of a resource's scope on a
// resource-scoped channel while that scope is held. Anything else is dropped,
// a request's echo included.

describe('what a reader is given', () => {
  const RID = resourceId('res-1');
  const FOCUS: EventMap['beckon:focus'] = { annotationId: annotationId('ann-1'), resourceId: RID };

  function archived(of: ResourceId): EventMap['mark:archived'] {
    return {
      id: `evt-${of}`,
      type: 'mark:archived',
      resourceId: of,
      userId: userId('did:web:example.org:users:alice'),
      version: 1,
      timestamp: '2026-01-01T00:00:00Z',
      payload: {},
      metadata: { sequenceNumber: 1 },
    };
  }

  /** Every value `observable` gives from now on. */
  function collect<T>(observable: Observable<T>): T[] {
    const seen: T[] = [];
    observable.subscribe((value) => seen.push(value));
    return seen;
  }

  /** What `read` threw. */
  function refusalOf(read: () => unknown): unknown {
    try {
      read();
    } catch (error) {
      return error;
    }
    throw new Error('the read was not refused');
  }

  it("gives a resource's frame only while its scope is held: each hold counts, and a release is idempotent", () => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    const archives = collect(transport.frames('mark:archived'));

    void transport.emit('mark:archived', archived(RID), { scope: RID });
    const first = transport.subscribeToResource(RID);
    const second = transport.subscribeToResource(RID);
    void transport.emit('mark:archived', archived(RID), { scope: RID });
    first();
    first();
    void transport.emit('mark:archived', archived(RID), { scope: RID });
    second();
    void transport.emit('mark:archived', archived(RID), { scope: RID });

    expect(archives.map((frame) => frame.scope)).toEqual([RID, RID]);
    transport.dispose();
  });

  it('gives a frame of no scope on a channel it was given, and drops one of a scope there, and one of no scope on a scoped channel', () => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    transport.subscribeToResource(RID);
    const focused = collect(transport.frames('beckon:focus'));
    const archives = collect(transport.frames('mark:archived'));

    void transport.emit('beckon:focus', FOCUS, { scope: RID });
    void transport.emit('mark:archived', archived(RID));
    void transport.emit('beckon:focus', FOCUS);

    expect(focused.map((frame) => frame.payload)).toEqual([FOCUS]);
    expect(archives).toEqual([]);
    transport.dispose();
  });

  it('refuses at the call a read of a channel it was not given and no resource scopes, as bus.unsubscribed', () => {
    const transport = new FaultyTransport({ channels: [BUS_OPERATIONS[OP].result] });

    for (const read of [() => transport.frames(OP), () => transport.stream(OP), () => transport.on(OP, () => {})]) {
      expect(refusalOf(read)).toMatchObject({ code: 'bus.unsubscribed', details: { channel: OP } });
    }
    transport.dispose();
  });

  it("gives a request's echo to a reader of a transport given the request's channel", async () => {
    const { result, failure } = BUS_OPERATIONS[OP];
    const transport = new FaultyTransport({ channels: [OP, result, failure], makeResponse: () => pageOf(1) });
    const echoes = collect(transport.frames(OP));

    await new Bus(transport).request(OP, { limit: 1 }, 1_000);

    expect(echoes.map((frame) => frame.payload)).toMatchObject([{ limit: 1 }]);
    transport.dispose();
  });

  it('bridges what a reader is given on the channels it was given, and on no other global channel', () => {
    const transport = new FaultyTransport({ channels: ['beckon:focus'] });
    const bridged = new EventBus();
    transport.bridgeInto(bridged);
    const focused = collect(bridged.on('beckon:focus'));
    const sparkled = collect(bridged.on('beckon:sparkle'));

    void transport.emit('beckon:sparkle', { annotationId: annotationId('ann-1') });
    void transport.emit('beckon:focus', FOCUS, { scope: RID });
    void transport.emit('beckon:focus', FOCUS);

    expect(focused).toEqual([FOCUS]);
    expect(sparkled).toEqual([]);
    bridged.destroy();
    transport.dispose();
  });

  it("bridges a resource's frame while its scope is held, with no scope, as a wire transport's bridge does", () => {
    const OTHER = resourceId('res-2');
    const transport = new FaultyTransport({ channels: ['beckon:focus'] });
    const bridged = new EventBus();
    transport.bridgeInto(bridged);
    // The bus's frames of no scope: what the bridge publishes, for a reader of the client's bus.
    const archives = collect(bridged.frames('mark:archived'));
    const release = transport.subscribeToResource(RID);

    void transport.emit('mark:archived', archived(RID), { scope: RID });
    void transport.emit('mark:archived', archived(OTHER), { scope: OTHER });
    release();
    void transport.emit('mark:archived', archived(RID), { scope: RID });

    expect(archives.map((frame) => frame.payload)).toEqual([archived(RID)]);
    bridged.destroy();
    transport.dispose();
  });
});

describe('what errors$ keeps for its first reader', () => {
  const failure = (said: string): SemiontError => new SemiontError(said, 'unavailable');

  /** The message of every failure `transport` says on `errors$` from now on. */
  function heard(transport: FaultyTransport): string[] {
    const messages: string[] = [];
    transport.errors$.subscribe((said) => messages.push(said.message));
    return messages;
  }

  it('its first reader, taken late, hears the latest ERRORS_KEPT_FOR_FIRST_READER_COUNT failures before it, in order, the oldest dropped', () => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    const beyond = 5;
    const failures = Array.from({ length: ERRORS_KEPT_FOR_FIRST_READER_COUNT + beyond }, (_, n) => `failure ${n}`);
    for (const said of failures) transport.fail(failure(said));

    expect(heard(transport)).toEqual(failures.slice(beyond));
    transport.dispose();
  });

  it('a later reader hears only the failures from when it reads', () => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    transport.fail(failure('before anyone read'));
    const first = heard(transport);
    transport.fail(failure('before the second read'));
    const second = heard(transport);
    transport.fail(failure('after both read'));

    expect(first).toEqual(['before anyone read', 'before the second read', 'after both read']);
    expect(second).toEqual(['after both read']);
    transport.dispose();
  });

  it('a reader taken after dispose hears nothing, of what failed before it or after, and is ended', () => {
    const transport = new FaultyTransport({ channels: BRIDGED_CHANNELS });
    transport.fail(failure('before anyone read'));
    transport.dispose();
    transport.fail(failure('after dispose'));

    let ended = false;
    const messages: string[] = [];
    transport.errors$.subscribe({ next: (said) => messages.push(said.message), complete: () => { ended = true; } });
    expect(messages).toEqual([]);
    expect(ended).toBe(true);
  });
});
