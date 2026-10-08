/**
 * `POST /bus/emit`: validation, the identity the gateway stamps, the profile
 * it publishes for a writer, claims and their refusals, and the answer to a
 * request nobody can answer. Semantics from docs/protocol/TRANSPORT-HTTP.md
 * § POST /bus/emit; statuses and bodies from the spec.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nonConformance } from '../harness/http';
import { SERVICE_ROLE, WORKER_ROLE } from '../harness/roles';
import { identifiers, operationFor, registry, spec } from '../harness/spec';
import { eventually } from '../harness/net';
import { eachPlane } from '../harness/world';

/** A request channel whose request payload validates with `resourceId` alone. */
const REQUEST = 'browse:resource-requested';
/** A broadcast every participant may emit, with no required field. */
const BROADCAST = 'beckon:focus';
/** A channel the registry says writes. */
const WRITE = 'frame:add-entity-type';

const pendingMax = () =>
  (spec().schema('BusSubscribeRequest') as { properties: { pendingReplies: { maxItems: number } } }).properties.pendingReplies.maxItems;

eachPlane('emitting', (world, plane) => {
  it('an emit is accepted with 202; the count of subscribers is present only when the plane can count them', async () => {
    const token = await world().person('emitter');
    const reply = await world().emit(token, { channel: BROADCAST, payload: {} });
    expect(reply.status, reply.text).toBe(202);
    expect(nonConformance('post', '/bus/emit', reply)).toEqual([]);
    const body = reply.json as { subscribers?: number };
    if (plane === 'nats') expect(body).toEqual({});
    else expect(typeof body.subscribers).toBe('number');
  });

  it('the gateway stamps the verified emitter as _userId and its token\'s roles as _roles, whoever issued the token, over whatever the caller wrote', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const person = await world().person('stamped');
    const worker = await world().agent('ollama', 'stamp-model', [SERVICE_ROLE, WORKER_ROLE]);
    const forged = { _userId: 'did:web:forged.example:users:mallory', _roles: ['semiont-admin'] };

    const marker1 = randomUUID();
    await world().emit(person, { channel: BROADCAST, payload: { annotationId: marker1, ...forged } });
    const fromPerson = await watcher.frame(BROADCAST, (f) => f.payload['annotationId'] === marker1);
    expect(fromPerson.payload['_userId']).toBe(world().personDid('stamped'));
    expect(fromPerson.payload['_roles']).toBeUndefined();

    const marker2 = randomUUID();
    await world().emit(worker.token, { channel: BROADCAST, payload: { annotationId: marker2, ...forged } });
    const fromWorker = await watcher.frame(BROADCAST, (f) => f.payload['annotationId'] === marker2);
    expect(fromWorker.payload['_userId']).toBe(worker.did);
    expect(fromWorker.payload['_roles']).toEqual([WORKER_ROLE]);

    // A person may hold a role as an agent may; the issuer's token carries it.
    const roled = await world().person('stamped-roled', { roles: [WORKER_ROLE] });
    const marker3 = randomUUID();
    await world().emit(roled, { channel: BROADCAST, payload: { annotationId: marker3, ...forged } });
    const fromRoled = await watcher.frame(BROADCAST, (f) => f.payload['annotationId'] === marker3);
    expect(fromRoled.payload['_userId']).toBe(world().personDid('stamped-roled'));
    expect(fromRoled.payload['_roles']).toEqual([WORKER_ROLE]);
  });

  it('concurrent emits by different principals are each stamped with their own', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const people = Array.from({ length: 8 }, (_, i) => `concurrent-${i}`);
    const tokens = await Promise.all(people.map((p) => world().person(p)));
    const marks = people.map(() => randomUUID());
    const replies = await Promise.all(tokens.map((token, i) => world().emit(token, { channel: BROADCAST, payload: { annotationId: marks[i] } })));
    expect(replies.map((r) => r.status)).toEqual(people.map(() => 202));
    for (const [i, person] of people.entries()) {
      const frame = await watcher.frame(BROADCAST, (f) => f.payload['annotationId'] === marks[i]);
      expect(frame.payload['_userId'], person).toBe(world().personDid(person));
    }
  });

  it('an emit is refused with 400 for an unknown channel, a payload that does not match its schema, or a scope that is empty', async () => {
    const token = await world().person('emitter');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['an unknown channel', { channel: 'no-such:channel', payload: {} }],
      ['no channel', { payload: {} }],
      ['no payload', { channel: BROADCAST }],
      ['a payload that is not an object', { channel: BROADCAST, payload: 'text' }],
      ['a payload that does not match', { channel: REQUEST, payload: { resourceId: 7 } }],
      ['a string where the schema says integer — never converted', { channel: 'tabs:reorder', payload: { oldIndex: '1', newIndex: '2' } }],
      ['an empty scope', { channel: BROADCAST, payload: {}, scope: '' }],
    ];
    for (const [why, body] of cases) {
      const reply = await world().emit(token, body);
      expect(reply.status, why).toBe(400);
      expect(nonConformance('post', '/bus/emit', reply), why).toEqual([]);
    }
  });

  // Each kind of id, on a channel whose payload carries one and needs nothing else.
  const carriers = [
    { kind: 'ResourceId', channel: BROADCAST, property: 'resourceId' },
    { kind: 'AnnotationId', channel: BROADCAST, property: 'annotationId' },
    { kind: 'JobId', channel: 'job:status-requested', property: 'jobId' },
  ];
  it.each(carriers)('a payload carrying a $kind is taken when the kind accepts it and refused with 400 when it does not (identifiers/kinds.json)', async ({ kind, channel, property }) => {
    const token = await world().person('emitter');
    const { accepts, refuses } = identifiers(kind);
    for (const { id, why } of refuses) {
      const reply = await world().emit(token, { channel, payload: { [property]: id } });
      expect(reply.status, `${JSON.stringify(id)}: ${why}`).toBe(400);
      expect(nonConformance('post', '/bus/emit', reply), why).toEqual([]);
    }
    for (const { id, why } of accepts) {
      const reply = await world().emit(token, { channel, payload: { [property]: id } });
      expect(reply.status, `${JSON.stringify(id)}: ${why}`).toBe(202);
    }
  });

  it('a scope is a resource\'s id: an emit under one the kind refuses is a 400, and under one it accepts is taken', async () => {
    const token = await world().person('emitter');
    const { accepts, refuses } = identifiers('ResourceId');
    for (const { id, why } of refuses) {
      const reply = await world().emit(token, { channel: BROADCAST, payload: {}, scope: id });
      expect(reply.status, `${JSON.stringify(id)}: ${why}`).toBe(400);
      expect(nonConformance('post', '/bus/emit', reply), why).toEqual([]);
    }
    for (const { id, why } of accepts) {
      const reply = await world().emit(token, { channel: BROADCAST, payload: {}, scope: id });
      expect(reply.status, `${JSON.stringify(id)}: ${why}`).toBe(202);
    }
  });

  it('a request carrying a correlationId needs a clientId', async () => {
    const token = await world().person('emitter');
    const reply = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId: randomUUID() });
    expect(reply.status).toBe(400);
    expect(nonConformance('post', '/bus/emit', reply)).toEqual([]);
  });

  it('a live correlationId cannot be claimed twice', async () => {
    const token = await world().person('emitter');
    const correlationId = randomUUID();
    const first = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId: randomUUID() });
    expect(first.status, first.text).toBe(202);
    const second = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId: randomUUID() });
    expect(second.status).toBe(409);
    expect(nonConformance('post', '/bus/emit', second)).toEqual([]);
  });

  it('a client may have as many unanswered requests as pendingReplies may name, and no more until one is answered', async () => {
    // Something must hear the requests and not answer them: a request that
    // reaches nobody is answered at once (below).
    const silent = await world().agent('conformance', 'silent');
    await world().subscribe(silent.token, { clientId: randomUUID(), global: [REQUEST] });
    const token = await world().person('busy');
    const clientId = randomUUID();
    const cids: string[] = [];
    for (let i = 0; i < pendingMax(); i++) {
      const correlationId = randomUUID();
      cids.push(correlationId);
      const reply = await world().emit(token, { channel: REQUEST, payload: { resourceId: `r-${i}` }, correlationId, clientId });
      expect(reply.status, `request ${i}`).toBe(202);
    }
    const over = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'over' }, correlationId: randomUUID(), clientId });
    expect(over.status).toBe(429);
    expect(nonConformance('post', '/bus/emit', over)).toEqual([]);
    // Retry-After is when the oldest unanswered claim expires: all were just made.
    const claimSeconds = spec().limits('post', '/bus/emit')['claimSeconds']!;
    const retryAfter = Number(over.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(claimSeconds - 30);
    expect(retryAfter).toBeLessThanOrEqual(claimSeconds);
    // Refused, not made room for: the oldest claim still stands.
    const oldest = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'r-1' }, correlationId: cids[1], clientId });
    expect(oldest.status).toBe(409);

    // Another client of the same person is not affected.
    const other = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'other' }, correlationId: randomUUID(), clientId: randomUUID() });
    expect(other.status).toBe(202);

    // An answer frees a slot.
    const responder = await world().agent('conformance', 'answerer');
    const { result } = operationFor(REQUEST);
    const answered = await world().emit(responder.token, {
      channel: result,
      payload: { response: { resource: { '@context': 'https://schema.org/', '@id': 'x', name: 'x', representations: [] }, annotations: [], entityReferences: [] } },
      correlationId: cids[0],
    });
    expect(answered.status, answered.text).toBe(202);
    const freed = await (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const reply = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'freed' }, correlationId: randomUUID(), clientId });
        if (reply.status === 202) return reply;
        await new Promise((r) => setTimeout(r, 20));
      }
      return undefined;
    })();
    expect(freed?.status).toBe(202);
    // One answer frees one slot.
    const next = await world().emit(token, { channel: REQUEST, payload: { resourceId: 'next' }, correlationId: randomUUID(), clientId });
    expect(next.status).toBe(429);
  });

  it('every write by a person publishes the name their token carries at that write, in order', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['person:profile'] });
    expect(registry().effect.writes).toContain(WRITE);
    const did = world().personDid('writes');
    for (const name of ['Wanda Writer', 'Wanda Writer', 'Wanda Renamed']) {
      const reply = await world().emit(await world().person('writes', { name }), { channel: WRITE, payload: { tag: 'Conformance' } });
      expect(reply.status, reply.text).toBe(202);
    }
    await watcher.next('the third profile', () => watcher.frames('person:profile').filter((f) => f.payload['_userId'] === did).length === 3);
    expect(watcher.frames('person:profile').filter((f) => f.payload['_userId'] === did).map((f) => f.payload['name'])).toEqual([
      'Wanda Writer',
      'Wanda Writer',
      'Wanda Renamed',
    ]);
  });

  it('a read, an agent\'s write, or a write by a token with no name publishes no profile', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['person:profile'] });
    expect(registry().effect.reads).toContain(REQUEST);

    const reader = await world().person('only-reads', { name: 'Rita Reader' });
    await world().emit(reader, { channel: REQUEST, payload: { resourceId: 'r' } });
    const agent = await world().agent('conformance', 'writer');
    expect((await world().emit(agent.token, { channel: WRITE, payload: { tag: 'Agent' } })).status).toBe(202);
    const nameless = await world().person('nameless', { name: undefined });
    expect((await world().emit(nameless, { channel: WRITE, payload: { tag: 'Nameless' } })).status).toBe(202);

    await watcher.quiet('person:profile', 500);
  });

  it('a request that reaches nobody is answered at once — to its requester only — with its operation\'s failure echoing the request, on either plane', async () => {
    const token = await world().person('lonely');
    const clientId = randomUUID();
    // A request channel nothing in this world answers.
    const request = 'browse:annotation-requested';
    const { failure } = operationFor(request);
    const stream = await world().subscribe(token, { clientId, global: [failure] });
    const otherClient = await world().subscribe(token, { clientId: randomUUID(), global: [failure] });
    const correlationId = randomUUID();
    const reply = await world().emit(token, { channel: request, payload: { resourceId: 'r-9', annotationId: 'a-9' }, correlationId, clientId });
    expect(reply.status, reply.text).toBe(202);
    // Observed on both planes: counted in-process, and a broker's own
    // no-responders answer on NATS — never a zero nobody saw.
    expect(reply.json).toEqual({ subscribers: 0 });
    const frame = await stream.frame(failure, (f) => f.correlationId === correlationId);
    expect(frame.payload).toMatchObject({ resourceId: 'r-9', annotationId: 'a-9', code: 'peer-unavailable' });
    expect(typeof frame.payload['message']).toBe('string');
    expect(frame.payload['_userId']).toBeUndefined();
    expect(frame.payload['_roles']).toBeUndefined();
    await otherClient.quiet(failure, 500);

    // A request with no correlationId has nobody to answer.
    const uncorrelated = await world().emit(token, { channel: request, payload: { resourceId: 'r-10', annotationId: 'a-10' } });
    expect(uncorrelated.status).toBe(202);
    await stream.quiet(failure, 500, (f) => f.payload['resourceId'] === 'r-10');
  });

  it('a request someone subscribes to is delivered and answered by nobody but them: no failure is synthesized, and a broker plane reports no count it did not observe', async () => {
    const token = await world().person('requester');
    const clientId = randomUUID();
    const request = 'browse:annotation-requested';
    const { failure } = operationFor(request);
    const stream = await world().subscribe(token, { clientId, global: [failure] });
    const participant = await world().agent('conformance', 'server');
    const server = await world().subscribe(participant.token, { clientId: randomUUID(), global: [request] });
    const correlationId = randomUUID();
    const reply = await world().emit(token, { channel: request, payload: { resourceId: 'r-11', annotationId: 'a-11' }, correlationId, clientId });
    expect(reply.status, reply.text).toBe(202);
    if (plane === 'nats') expect(reply.json).toEqual({});
    else expect(reply.json).toEqual({ subscribers: 1 });
    await server.frame(request, (f) => f.correlationId === correlationId);
    await stream.quiet(failure, 500);
  });

  it('a reply with no correlationId reaches no one', async () => {
    const { result } = operationFor(REQUEST);
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [result] });
    const participant = await world().agent('conformance', 'uncorrelated');
    const reply = await world().emit(participant.token, {
      channel: result,
      payload: { response: { resource: { '@context': 'https://schema.org/', '@id': 'x', name: 'x', representations: [] }, annotations: [], entityReferences: [] } },
    });
    expect(reply.status, reply.text).toBe(202);
    await watcher.quiet(result, 500);
  });

  it('a job request gets no answer from the gateway: the queue is the dispatcher\'s', async () => {
    const token = await world().person('claimer');
    const clientId = randomUUID();
    const { result, failure } = operationFor('job:claim');
    const stream = await world().subscribe(token, { clientId, global: [result, failure] });
    const correlationId = randomUUID();
    const reply = await world().emit(token, { channel: 'job:claim', payload: { accepts: [{ jobType: 'yield' }] }, correlationId, clientId });
    expect(reply.status, reply.text).toBe(202);
    // The only answer is the gateway saying nobody is there to give one.
    const frame = await stream.frame(failure, (f) => f.correlationId === correlationId);
    expect(frame.payload['code']).toBe('peer-unavailable');
    await stream.quiet(result, 500);
  });

  it('a correlationId key inside a payload is the caller\'s data: delivered unchanged, and it routes nothing', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const token = await world().person('emitter');
    const marker = randomUUID();
    await world().emit(token, { channel: BROADCAST, payload: { annotationId: marker, correlationId: 'inside-the-payload' } });
    const frame = await watcher.frame(BROADCAST, (f) => f.payload['annotationId'] === marker);
    expect(frame.payload['correlationId']).toBe('inside-the-payload');
    expect(frame.correlationId).toBeUndefined();
  });
});

// Only a plane that can count reports a count (TRANSPORT-HTTP.md § POST /bus/emit).
eachPlane('counting subscribers', (world) => {
  it('an emit reports exactly how many connections its channel and scope reached', async () => {
    const token = await world().person('counter');
    const count = async (body: Record<string, unknown>) => ((await world().emit(token, body)).json as { subscribers: number }).subscribers;
    const scope = `res-${randomUUID()}`;
    const scoped = { channel: BROADCAST, payload: {}, scope };
    const global = { channel: BROADCAST, payload: {} };

    expect(await count(global)).toBe(0);
    expect(await count(scoped)).toBe(0);
    const first = await world().subscribe(token, { clientId: randomUUID(), scoped: [{ scope, channels: [BROADCAST] }] });
    expect(await count(scoped)).toBe(1);
    await world().subscribe(token, { clientId: randomUUID(), scoped: [{ scope, channels: [BROADCAST] }] });
    expect(await count(scoped)).toBe(2);
    await world().subscribe(token, { clientId: randomUUID(), global: [BROADCAST] });
    expect(await count(scoped)).toBe(2);
    expect(await count(global)).toBe(1);

    first.close();
    await eventually('the closed connection to stop counting', 5_000, async () => ((await count(scoped)) === 1 ? true : undefined));
  });
}, {}, ['in-process']);
