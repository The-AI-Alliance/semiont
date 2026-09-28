/**
 * Several gateways on one broker are one gateway to their clients: a reply
 * reaches its requester whichever replica each is connected to, a claim made
 * on one is known to the others, and a reply retained by one is recovered
 * through another — or through the same one after it restarts.
 * docs/protocol/TRANSPORT-HTTP.md § POST /bus/emit (Claims) and § Correlated-
 * reply retention. NATS only: the in-process plane is one process.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import type { GatewayProcess } from '../harness/gateway';
import { eventually } from '../harness/net';
import { operationFor, spec } from '../harness/spec';
import { subscribe } from '../harness/stream';
import { eachPlane } from '../harness/world';

const REQUEST = 'browse:resource-requested';
const described = {
  response: {
    resource: { '@context': 'https://schema.org/', '@id': 'https://kb.example/r', name: 'r', representations: [] },
    annotations: [],
    entityReferences: [],
  },
};

/** A request the participant leaves for the case to answer when it chooses. */
const LATER = 'later';

eachPlane('two replicas on one broker', (world) => {
  const { result } = operationFor(REQUEST);
  let b: GatewayProcess;
  /** The participant's token: it answers REQUEST, and replies by hand to LATER. */
  let participant: string;

  beforeAll(async () => {
    b = await world().replica();
    // The service that answers REQUEST is connected to replica B.
    participant = (
      await world().responder([REQUEST], (frame) => (frame.payload['resourceId'] === LATER ? undefined : { channel: result, payload: described }), b.origin)
    ).token;
  });

  const answer = (correlationId: string, name = 'r', origin = b.origin) =>
    world().emit(participant, { channel: result, payload: { response: { ...described.response, resource: { ...described.response.resource, name } } }, correlationId }, origin);

  it('the streams one principal holds are counted across replicas', async () => {
    const { baseline } = spec().principalLimit<number>('post', '/bus/subscribe', 'streamsPerPrincipal');
    const carol = await world().person('carol-streams');
    for (let i = 0; i < baseline; i++) {
      await world().subscribe(carol, { clientId: randomUUID(), global: ['beckon:focus'] }, i % 2 === 0 ? world().origin : b.origin);
    }
    for (const origin of [world().origin, b.origin]) {
      const over = await eventually(`${origin} refuses past the limit`, 10_000, async () => {
        const reply = await subscribe(origin, carol, { clientId: randomUUID(), global: ['beckon:focus'] });
        reply.stream?.close();
        return reply.status === 429 ? reply : undefined;
      });
      expect(over.status).toBe(429);
    }
  });

  it('the streams a replica held stop counting once their lease ends, when the replica died without releasing them', async () => {
    const { baseline } = spec().principalLimit<number>('post', '/bus/subscribe', 'streamsPerPrincipal');
    const heartbeat = spec().limits('post', '/bus/subscribe')['heartbeatSeconds']!;
    const c = await world().replica();
    const dave = await world().person('dave-streams');
    for (let i = 0; i < baseline; i++) await world().subscribe(dave, { clientId: randomUUID(), global: ['beckon:focus'] }, c.origin);
    const probe = async (status: number) => {
      const reply = await subscribe(world().origin, dave, { clientId: randomUUID(), global: ['beckon:focus'] });
      reply.stream?.close();
      return reply.status === status ? reply : undefined;
    };
    await eventually('the other replica counts them', 10_000, () => probe(429));
    await c.crash();
    const died = Date.now();
    await eventually('a stream admitted once the dead replica\'s leases end', (2 * heartbeat + 15) * 1000, () => probe(200));
    expect(Date.now() - died, 'not before the lease could have ended').toBeGreaterThan(heartbeat * 1000);
  });

  it('a request made through one replica is answered to its requester through that replica, and to no one on the other', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const requester = await world().subscribe(alice, { clientId, global: [result] });
    const bystander = await world().subscribe(alice, { clientId: randomUUID(), global: [result] }, b.origin);
    const correlationId = randomUUID();
    const reply = await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId });
    expect(reply.status, reply.text).toBe(202);
    const answer = await requester.frame(result, (f) => f.correlationId === correlationId);
    expect(answer.payload['response']).toEqual(described.response);
    await bystander.quiet(result, 500);
  });

  it('a request made through one replica is answered on the other, when that is where its requester listens', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const requester = await world().subscribe(alice, { clientId, global: [result] }, b.origin);
    const bystander = await world().subscribe(alice, { clientId: randomUUID(), global: [result] });
    const correlationId = randomUUID();
    expect((await world().emit(alice, { channel: REQUEST, payload: { resourceId: LATER }, correlationId, clientId })).status).toBe(202);
    for (const name of ['one', 'two', 'three']) expect((await answer(correlationId, name, world().origin)).status).toBe(202);
    await requester.next('the third reply', () => requester.frames(result).length === 3);
    expect(requester.frames(result).map((f) => (f.payload['response'] as typeof described.response).resource.name)).toEqual(['one', 'two', 'three']);
    await bystander.quiet(result, 300);
  });

  it('a correlationId is any string: one full of the broker\'s metacharacters claims, conflicts, routes and is recovered like any other', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const correlationId = `a:b.c *>/ é-${randomUUID()}`;
    const requester = await world().subscribe(alice, { clientId, global: [result] });
    expect((await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId })).status).toBe(202);
    const live = await requester.frame(result, (f) => f.correlationId === correlationId);
    expect(live.payload['response']).toEqual(described.response);
    for (const origin of [world().origin, b.origin]) {
      const again = await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId }, origin);
      expect(again.status, origin).toBe(409);
    }
    const recovered = await world().subscribe(alice, { clientId, global: [result], pendingReplies: [correlationId] }, b.origin);
    expect(recovered.frames(result).map((f) => f.correlationId)).toEqual([correlationId]);
  });

  it('a claim outstanding when a replica starts, or restarts, is answered live to a requester connected there', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();

    const early = randomUUID();
    expect((await world().emit(alice, { channel: REQUEST, payload: { resourceId: LATER }, correlationId: early, clientId })).status).toBe(202);
    const late = await world().replica();
    const onLate = await world().subscribe(alice, { clientId, global: [result] }, late.origin);
    expect((await answer(early)).status).toBe(202);
    await onLate.frame(result, (f) => f.correlationId === early);

    const across = randomUUID();
    expect((await world().emit(alice, { channel: REQUEST, payload: { resourceId: LATER }, correlationId: across, clientId })).status).toBe(202);
    await world().restart();
    const onRestarted = await world().subscribe(alice, { clientId, global: [result] });
    expect((await answer(across)).status).toBe(202);
    await onRestarted.frame(result, (f) => f.correlationId === across);
  });

  it('a client whose requests were all answered may ask again on any replica, and after a restart', async () => {
    const max = (spec().schema('BusSubscribeRequest') as { properties: { pendingReplies: { maxItems: number } } }).properties.pendingReplies.maxItems;
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const requester = await world().subscribe(alice, { clientId, global: [result] });
    for (let i = 0; i < max; i++) {
      const reply = await world().emit(alice, { channel: REQUEST, payload: { resourceId: `r-${i}` }, correlationId: randomUUID(), clientId });
      expect(reply.status, `request ${i}`).toBe(202);
    }
    await requester.next(`all ${max} replies`, () => requester.frames(result).length === max, 30_000);
    await new Promise((r) => setTimeout(r, 1_000));

    const onB = await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId: randomUUID(), clientId }, b.origin);
    expect(onB.status, onB.text).toBe(202);
    await world().restart();
    const afterRestart = await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId: randomUUID(), clientId });
    expect(afterRestart.status, afterRestart.text).toBe(202);
  }, 60_000);

  it('a correlationId claimed on one replica cannot be claimed on the other', async () => {
    const alice = await world().person('alice');
    const correlationId = randomUUID();
    // Nobody hears this channel, so nothing answers the claim in the meantime.
    const channel = 'browse:kb-requested';
    const first = await world().emit(alice, { channel, payload: {}, correlationId, clientId: randomUUID() });
    expect(first.status).toBe(202);
    const second = await world().emit(alice, { channel, payload: {}, correlationId, clientId: randomUUID() }, b.origin);
    expect(second.status).toBe(409);
  });

  it('a client\'s unanswered requests count against it on every replica', async () => {
    const max = (spec().schema('BusSubscribeRequest') as { properties: { pendingReplies: { maxItems: number } } }).properties.pendingReplies.maxItems;
    const alice = await world().person('alice');
    const clientId = randomUUID();
    for (let i = 0; i < max; i++) {
      const origin = i % 2 === 0 ? world().origin : b.origin;
      const reply = await world().emit(alice, { channel: 'browse:kb-requested', payload: {}, correlationId: randomUUID(), clientId }, origin);
      expect(reply.status, `request ${i}`).toBe(202);
    }
    // A probe that is accepted is a claim of its own, so each replica is
    // probed once, after the shared table has had time to reach both.
    await new Promise((r) => setTimeout(r, 1_000));
    for (const origin of [world().origin, b.origin]) {
      const reply = await world().emit(alice, { channel: 'browse:kb-requested', payload: {}, correlationId: randomUUID(), clientId }, origin);
      expect(reply.status, origin).toBe(429);
    }
  });

  it('a reply retained while its requester was away is recovered through the other replica', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const correlationId = randomUUID();
    await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId });
    await new Promise((r) => setTimeout(r, 500));
    const recovered = await world().subscribe(alice, { clientId, global: [result], pendingReplies: [correlationId] }, b.origin);
    expect(recovered.frames(result).map((f) => f.correlationId)).toContain(correlationId);
  });

  it('claims and retained replies survive a replica\'s restart', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const answered = randomUUID();
    await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId: answered, clientId });
    const pending = randomUUID();
    await world().emit(alice, { channel: 'browse:kb-requested', payload: {}, correlationId: pending, clientId });
    await new Promise((r) => setTimeout(r, 500));

    await world().restart();

    const conflict = await world().emit(alice, { channel: 'browse:kb-requested', payload: {}, correlationId: pending, clientId });
    expect(conflict.status).toBe(409);
    const recovered = await world().subscribe(alice, { clientId, global: [result], pendingReplies: [answered] });
    expect(recovered.frames(result).map((f) => f.correlationId)).toContain(answered);
  });
}, {}, ['nats']);
