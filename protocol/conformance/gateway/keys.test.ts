/**
 * An emit or an upload sent again under its `Idempotency-Key`
 * (protocol/specs/src/paths/bus_emit.json and paths/resources.json, A key): a
 * repeat with the body its key was first sent with is answered as the first
 * was, and carried out once; one with another body is refused 422; one that
 * arrives while the first is in hand waits for it; a key is its principal's;
 * and one without a key, or with a key that is not 1 to 255 characters, is
 * refused 400. The gateway answers a repeated emit itself, and passes an
 * upload's key to the Archivist, whose stand-in answers its repeats
 * (harness/archivist.ts). A key recognised on another replica:
 * replicas.test.ts; an upload recorded and never answered:
 * archivist-waits.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { call, nonConformance, type Reply } from '../harness/http';
import { startHoldingProxy } from '../harness/proxy';
import { operationFor, spec } from '../harness/spec';
import type { BusFrame, BusStream } from '../harness/stream';
import { eachPlane } from '../harness/world';

/** A broadcast every participant may emit: a command, not an operation's request. */
const BROADCAST = 'beckon:focus';
/** An operation's request whose payload validates with `resourceId` alone. */
const REQUEST = 'browse:resource-requested';
const described = {
  response: {
    resource: { '@context': 'https://schema.org/', '@id': 'r', name: 'r', representations: [] },
    lastSequence: 1,
  },
};

/** A command a watcher can pick out by `marker`. */
const command = (marker: string) => ({ channel: BROADCAST, payload: { annotationId: marker, resourceId: 'res-1' } });
const marked = (marker: string) => (f: BusFrame) => f.payload['annotationId'] === marker;

/** What a repeat must equal: the first's status and body. */
const answered = (reply: Reply) => ({ status: reply.status, body: reply.json });

/** The frames on `channel` that `match` accepts, once the first has come and a second has had time to. */
async function settled(stream: BusStream, channel: string, match: (f: BusFrame) => boolean): Promise<BusFrame[]> {
  await stream.frame(channel, match);
  await new Promise((r) => setTimeout(r, 500));
  return stream.frames(channel).filter(match);
}

/** The longest `Idempotency-Key` the spec admits on `POST path`. */
function longestKey(path: string): number {
  const parameters = spec().operation('post', path)['parameters'];
  for (const parameter of Array.isArray(parameters) ? parameters : []) {
    const p = spec().deref(parameter);
    if (typeof p !== 'object' || p === null || Array.isArray(p) || p['name'] !== 'Idempotency-Key') continue;
    const schema = p['schema'];
    const maxLength = typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? schema['maxLength'] : undefined;
    if (typeof maxLength === 'number') return maxLength;
  }
  throw new Error(`POST ${path} declares no Idempotency-Key with a maxLength`);
}

/** The keys the spec refuses on `POST path`: none, an empty one, and one a character too long. */
const refusedKeys = (path: string): Array<[string, Record<string, string>]> => [
  ['no key', {}],
  ['an empty key', { 'idempotency-key': '' }],
  [`a key of ${longestKey(path) + 1} characters`, { 'idempotency-key': 'k'.repeat(longestKey(path) + 1) }],
];

/** An upload's fields, at a storageUri of its own. */
const uploadFields = () => ({ name: 'Keyed', format: 'text/plain', storageUri: `file://uploads/${randomUUID()}` });

function form(fields: Record<string, string>, bytes: string): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  body.set('file', new Blob([bytes], { type: 'text/plain' }), 'keyed.txt');
  return body;
}

eachPlane('sending again under a key', (world) => {
  it('an emit with no key, or one that is not 1 to 255 characters, is refused 400 and not published; one of 255 is taken', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const token = await world().person('keyless');
    const refused: string[] = [];
    for (const [why, headers] of refusedKeys('/bus/emit')) {
      const marker = randomUUID();
      refused.push(marker);
      const reply = await call(world().origin, 'POST', '/bus/emit', { token, json: command(marker), headers });
      expect(reply.status, why).toBe(400);
      expect(nonConformance('post', '/bus/emit', reply), why).toEqual([]);
    }
    const taken = await world().emit(token, command(randomUUID()), world().origin, randomUUID().padEnd(longestKey('/bus/emit'), 'k'));
    expect(taken.status, taken.text).toBe(202);
    await watcher.quiet(BROADCAST, 500, (f) => refused.some((marker) => marked(marker)(f)));
  });

  it('an upload with no key, or one that is not 1 to 255 characters, is refused 400 and never reaches the Archivist; one of 255 reaches it as it came', async () => {
    const token = await world().person('keyless-uploader');
    const uploadsSent = () => world().archivist.calls.filter((c) => c.method === 'POST' && c.path === '/resources').length;
    const sent = uploadsSent();
    for (const [why, headers] of refusedKeys('/resources')) {
      const reply = await call(world().origin, 'POST', '/resources', { token, body: form(uploadFields(), 'the bytes'), headers });
      expect(reply.status, why).toBe(400);
      expect(nonConformance('post', '/resources', reply), why).toEqual([]);
    }
    expect(uploadsSent()).toBe(sent);

    const key = randomUUID().padEnd(longestKey('/resources'), 'k');
    const fields = uploadFields();
    const taken = await world().upload(token, form(fields, 'the bytes'), key);
    expect(taken.status, taken.text).toBe(202);
    expect(world().archivist.uploads.find((u) => u.fields['storageUri'] === fields.storageUri)?.key).toBe(key);
  });

  it('a command sent again under its key is published once, and the repeat is answered as the first was, status and body', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const token = await world().person('repeats');
    const marker = randomUUID();
    const key = randomUUID();
    const first = await world().emit(token, command(marker), world().origin, key);
    expect(first.status, first.text).toBe(202);
    const again = await world().emit(token, command(marker), world().origin, key);
    expect(nonConformance('post', '/bus/emit', again)).toEqual([]);
    expect(answered(again)).toEqual(answered(first));
    expect(await settled(watcher, BROADCAST, marked(marker))).toHaveLength(1);
  });

  it('an operation\'s request sent again under its key is answered as the first was, never 409: published once, and its reply reaches its requester', async () => {
    const { result } = operationFor(REQUEST);
    // Heard, and left unanswered until the case answers it, so the claim is live when the repeat arrives.
    const server = await world().agent('answers-by-hand');
    const heard = await world().subscribe(server.token, { clientId: randomUUID(), global: [REQUEST] });
    const requester = await world().person('requests-twice');
    const clientId = randomUUID();
    const replies = await world().subscribe(requester, { clientId, global: [result] });
    const correlationId = randomUUID();
    const key = randomUUID();
    const request = { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId };

    const first = await world().emit(requester, request, world().origin, key);
    expect(first.status, first.text).toBe(202);
    const again = await world().emit(requester, request, world().origin, key);
    expect(nonConformance('post', '/bus/emit', again)).toEqual([]);
    expect(answered(again)).toEqual(answered(first));

    await heard.frame(REQUEST, (f) => f.correlationId === correlationId);
    const reply = await world().emit(server.token, { channel: result, payload: described, correlationId });
    expect(reply.status, reply.text).toBe(202);
    const delivered = await replies.frame(result, (f) => f.correlationId === correlationId);
    expect(delivered.payload['response']).toEqual(described.response);
    expect(await settled(heard, REQUEST, (f) => f.correlationId === correlationId)).toHaveLength(1);
  });

  it('a key sent again with another body is refused 422 unprocessable, every time, and nothing is published; its first body is still answered as it was', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const token = await world().person('reuses-a-key');
    const key = randomUUID();
    const firstMarker = randomUUID();
    const otherMarker = randomUUID();
    const first = await world().emit(token, command(firstMarker), world().origin, key);
    expect(first.status, first.text).toBe(202);

    for (const attempt of ['once', 'and again']) {
      const refused = await world().emit(token, command(otherMarker), world().origin, key);
      expect(refused.status, attempt).toBe(422);
      expect(nonConformance('post', '/bus/emit', refused), attempt).toEqual([]);
      expect((refused.json as { code?: string }).code, attempt).toBe('unprocessable');
    }
    const again = await world().emit(token, command(firstMarker), world().origin, key);
    expect(answered(again)).toEqual(answered(first));

    await watcher.quiet(BROADCAST, 500, marked(otherMarker));
    expect(watcher.frames(BROADCAST).filter(marked(firstMarker))).toHaveLength(1);
  });

  it('two sends under one key at once are published once, and answered alike', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const token = await world().person('sends-twice-at-once');
    const marker = randomUUID();
    const key = randomUUID();
    const [one, two] = await Promise.all([
      world().emit(token, command(marker), world().origin, key),
      world().emit(token, command(marker), world().origin, key),
    ]);
    expect(one.status, one.text).toBe(202);
    for (const reply of [one, two]) expect(nonConformance('post', '/bus/emit', reply)).toEqual([]);
    expect(answered(two)).toEqual(answered(one));
    expect(await settled(watcher, BROADCAST, marked(marker))).toHaveLength(1);
  });

  it('a key is its principal\'s: the same key and body from two principals are two emits, each published and stamped with its own', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const person = await world().person('shares-a-key');
    const agent = await world().agent('shares-a-key');
    const marker = randomUUID();
    const key = randomUUID();
    for (const token of [person, agent.token]) {
      const reply = await world().emit(token, command(marker), world().origin, key);
      expect(reply.status, reply.text).toBe(202);
    }
    await watcher.next('both emits', () => watcher.frames(BROADCAST).filter(marked(marker)).length === 2);
    const stamped = watcher.frames(BROADCAST).filter(marked(marker)).map((f) => f.payload['_userId']);
    expect(new Set(stamped)).toEqual(new Set([world().personDid('shares-a-key'), agent.did]));
  });

  it('an upload sent again under its key makes one resource, and both answers name it', async () => {
    const token = await world().person('uploads-twice');
    const key = randomUUID();
    const fields = uploadFields();
    const first = await world().upload(token, form(fields, 'the bytes'), key);
    expect(first.status, first.text).toBe(202);
    const again = await world().upload(token, form(fields, 'the bytes'), key);
    expect(again.status, again.text).toBe(202);
    expect(nonConformance('post', '/resources', again)).toEqual([]);

    const made = world().archivist.uploads.filter((u) => u.fields['storageUri'] === fields.storageUri);
    expect(made).toHaveLength(1);
    expect(made[0]!.key).toBe(key);
    for (const reply of [first, again]) expect(reply.json).toEqual({ resourceId: made[0]!.resourceId });
  });

  it('an upload\'s key sent again with other fields or other bytes is refused 422 unprocessable, and nothing more is recorded', async () => {
    const token = await world().person('reuses-an-upload-key');
    const key = randomUUID();
    const fields = uploadFields();
    const first = await world().upload(token, form(fields, 'the bytes'), key);
    expect(first.status, first.text).toBe(202);

    const others: Array<[string, FormData]> = [
      ['other bytes', form(fields, 'other bytes')],
      ['other fields', form({ ...fields, name: 'Another name' }, 'the bytes')],
    ];
    for (const [why, body] of others) {
      const refused = await world().upload(token, body, key);
      expect(refused.status, why).toBe(422);
      expect(nonConformance('post', '/resources', refused), why).toEqual([]);
      expect((refused.json as { code?: string }).code, why).toBe('unprocessable');
    }
    expect(world().archivist.uploads.filter((u) => u.fields['storageUri'] === fields.storageUri)).toHaveLength(1);
  });
});

// Held between the gateway and its broker, the first is in hand for as long as
// the case chooses: only a broker can be stood between. On the in-process
// plane the two are sent at once, above.
eachPlane('a repeat that arrives while the first is in hand', (world) => {
  it('waits for the first, held on its way to the broker, and is answered as it was: one publish', async () => {
    const broker = world().broker;
    if (!broker) throw new Error('holding an emit on its way needs the broker');
    const proxy = await startHoldingProxy(broker.port);
    const held = await world().replica(proxy.url);
    try {
      // On the gateway that reaches the broker directly: the hold is on the other.
      const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
      const token = await world().person('held');
      const marker = randomUUID();
      const key = randomUUID();
      proxy.hold();
      const first = world().emit(token, command(marker), held.origin, key);
      await new Promise((r) => setTimeout(r, 300));
      const second = world().emit(token, command(marker), held.origin, key);
      await new Promise((r) => setTimeout(r, 700));
      proxy.release();
      const [one, two] = await Promise.all([first, second]);
      expect(one.status, one.text).toBe(202);
      for (const reply of [one, two]) expect(nonConformance('post', '/bus/emit', reply)).toEqual([]);
      expect(answered(two)).toEqual(answered(one));
      expect(await settled(watcher, BROADCAST, marked(marker))).toHaveLength(1);
    } finally {
      proxy.release();
      await held.stop();
      await proxy.close();
    }
  }, 30_000);
}, {}, ['nats']);
