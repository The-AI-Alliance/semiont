/**
 * What the gateway leaves on the broker it shares with the dispatcher. The
 * signal plane is never a record: no frame it carries is captured by a
 * stream (docs/protocol/EVENT-BUS.md § Where the bus lives) — the only
 * streams it creates are the key-value tables its ledger keeps claims and
 * retained replies in — and nothing it publishes lands in the dispatcher's
 * job stream, which shares the broker. NATS only.
 */
import { randomUUID } from 'node:crypto';
import { connect, type NatsConnection } from 'nats';
import { JOBS_STREAM_SUBJECTS } from '@semiont/jobs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { operationFor } from '../harness/spec';
import { eachPlane } from '../harness/world';

const REQUEST = 'browse:resource-requested';

eachPlane('the broker', (world) => {
  let nc: NatsConnection;
  const JOBS = 'CONFORMANCE_JOBS';

  beforeAll(async () => {
    nc = await connect({ servers: world().broker!.url });
    // The dispatcher's stream, as the dispatcher declares it.
    await (await nc.jetstreamManager()).streams.add({ name: JOBS, subjects: [...JOBS_STREAM_SUBJECTS] });
  });
  afterAll(async () => {
    await nc.close();
  });

  it('holds no stream the gateway made but its key-value tables, and nothing it published is in the job stream', async () => {
    // Traffic of every kind: a broadcast, a scoped broadcast, a request, its reply, a recovery.
    const { result } = operationFor(REQUEST);
    await world().responder([REQUEST], () => ({
      channel: result,
      payload: { response: { resource: { '@context': 'https://schema.org/', '@id': 'x', name: 'x', representations: [] }, annotations: [], entityReferences: [] } },
    }));
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const stream = await world().subscribe(alice, { clientId, global: [result, 'beckon:focus'], scoped: [{ scope: 'res-broker', channels: ['beckon:focus'] }] });
    await world().emit(alice, { channel: 'beckon:focus', payload: {} });
    await world().emit(alice, { channel: 'beckon:focus', payload: {}, scope: 'res-broker' });
    const correlationId = randomUUID();
    await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId });
    await stream.frame(result, (f) => f.correlationId === correlationId);
    await world().subscribe(alice, { clientId, global: [result], pendingReplies: [correlationId] });

    const jsm = await nc.jetstreamManager();
    const names: string[] = [];
    for await (const info of jsm.streams.list()) names.push(info.config.name);
    expect(names.filter((n) => n !== JOBS && !n.startsWith('KV_'))).toEqual([]);
    expect(names.filter((n) => n.startsWith('KV_')).length).toBeGreaterThan(0);
    expect((await jsm.streams.info(JOBS)).state.messages).toBe(0);
  });
}, {}, ['nats']);
