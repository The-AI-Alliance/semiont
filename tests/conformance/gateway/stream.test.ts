/**
 * `POST /bus/subscribe`: what reaches which connection, replay and its gaps,
 * the recovery of replies, presence and the heartbeat. Every message every
 * stream here carries is also checked against BusStreamMessage and the id
 * rules (harness/stream.ts). Semantics from docs/protocol/TRANSPORT-HTTP.md
 * § POST /bus/subscribe and § Event id and resumption.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { storedEvent } from '../harness/archivist';
import { call, nonConformance } from '../harness/http';
import { operationFor, spec } from '../harness/spec';
import type { BusStream } from '../harness/stream';
import { eachPlane } from '../harness/world';

const BROADCAST = 'beckon:focus';
const REQUEST = 'browse:resource-requested';
const PERSISTED = 'mark:added';
const OTHER_PERSISTED = 'mark:removed';

const describedResult = {
  response: {
    resource: { '@context': 'https://schema.org/', '@id': 'r', name: 'r', representations: [] },
    annotations: [],
    entityReferences: [],
  },
};

eachPlane('subscribing', (world) => {
  const { result } = operationFor(REQUEST);
  /** The one participant answering REQUEST in this file; its token can emit replies. */
  let responder: { token: string };
  beforeAll(async () => {
    responder = await world().responder([REQUEST], () => ({ channel: result, payload: describedResult }));
  });

  it('a subscription that does not validate is a 400 ErrorResponse', async () => {
    const token = await world().person('subscriber');
    const cases: Array<[string, unknown]> = [
      ['no clientId', { global: [BROADCAST] }],
      ['nothing subscribed', { clientId: randomUUID() }],
      ['a scope named twice', { clientId: randomUUID(), scoped: [{ scope: 'r', channels: [PERSISTED] }, { scope: 'r', channels: [OTHER_PERSISTED] }] }],
      ['a scoped entry with no channels', { clientId: randomUUID(), scoped: [{ scope: 'r', channels: [] }] }],
      ['a scoped entry with no scope', { clientId: randomUUID(), scoped: [{ channels: [PERSISTED] }] }],
      ['a scoped entry with an empty scope', { clientId: randomUUID(), scoped: [{ scope: '', channels: [PERSISTED] }] }],
      ['pendingReplies that are not a list', { clientId: randomUUID(), global: [BROADCAST], pendingReplies: 'nope' }],
      ['pendingReplies that are not strings', { clientId: randomUUID(), global: [BROADCAST], pendingReplies: [1] }],
    ];
    for (const [why, body] of cases) {
      const reply = await call(world().origin, 'POST', '/bus/subscribe', { token, json: body });
      expect(reply.status, why).toBe(400);
      expect(nonConformance('post', '/bus/subscribe', reply), why).toEqual([]);
    }
  });

  it('an unscoped frame reaches the global subscribers of its channel; a scoped one only that scope\'s', async () => {
    const token = await world().person('subscriber');
    const scope = `res-${randomUUID()}`;
    const global = await world().subscribe(token, { clientId: randomUUID(), global: [BROADCAST] });
    const scoped = await world().subscribe(token, { clientId: randomUUID(), scoped: [{ scope, channels: [BROADCAST] }] });
    const elsewhere = await world().subscribe(token, { clientId: randomUUID(), scoped: [{ scope: `res-${randomUUID()}`, channels: [BROADCAST] }] });
    const emitter = await world().person('emitter');

    const unscopedMark = randomUUID();
    await world().emit(emitter, { channel: BROADCAST, payload: { annotationId: unscopedMark } });
    const unscoped = await global.frame(BROADCAST, (f) => f.payload['annotationId'] === unscopedMark);
    expect(unscoped.scope).toBeUndefined();

    const scopedMark = randomUUID();
    await world().emit(emitter, { channel: BROADCAST, payload: { annotationId: scopedMark }, scope });
    const inScope = await scoped.frame(BROADCAST, (f) => f.payload['annotationId'] === scopedMark);
    expect(inScope.scope).toBe(scope);

    await global.quiet(BROADCAST, 300, (f) => f.payload['annotationId'] === scopedMark);
    await scoped.quiet(BROADCAST, 0, (f) => f.payload['annotationId'] === unscopedMark);
    const marks: string[] = [scopedMark, unscopedMark];
    await elsewhere.quiet(BROADCAST, 0, (f) => marks.includes(String(f.payload['annotationId'])));
  });

  it('one connection holds global channels and several scopes: each frame arrives tagged with its own scope, a global one untagged', async () => {
    const token = await world().person('subscriber');
    const [a, b] = [`res-${randomUUID()}`, `res-${randomUUID()}`];
    const stream = await world().subscribe(token, {
      clientId: randomUUID(),
      global: [BROADCAST],
      scoped: [
        { scope: a, channels: [BROADCAST] },
        { scope: b, channels: [BROADCAST] },
      ],
    });
    const emitter = await world().person('emitter');
    const mark = randomUUID();
    for (const scope of [a, b, undefined]) {
      const reply = await world().emit(emitter, { channel: BROADCAST, payload: { annotationId: mark, at: scope ?? 'global' }, ...(scope ? { scope } : {}) });
      expect(reply.status, reply.text).toBe(202);
    }
    await stream.next('all three frames', () => stream.frames(BROADCAST).filter((f) => f.payload['annotationId'] === mark).length === 3);
    const frames = stream.frames(BROADCAST).filter((f) => f.payload['annotationId'] === mark);
    expect(frames.map((f) => [f.payload['at'], f.scope ?? null])).toEqual([[a, a], [b, b], ['global', null]]);
  });

  it('each scope on a connection resumes on its own: a watermarked one replays, a fresh sibling stays silent, and a watermark that names no position gaps only its own scope without a read', async () => {
    const [replaying, fresh, broken] = [`res-${randomUUID()}`, `res-${randomUUID()}`, `res-${randomUUID()}`];
    world().archivist.events.set(replaying, [storedEvent(PERSISTED, replaying, 1), storedEvent(PERSISTED, replaying, 2)]);
    world().archivist.events.set(fresh, [storedEvent(PERSISTED, fresh, 1)]);
    const reads = () => world().archivist.calls.filter((c) => c.path.startsWith('/events/')).map((c) => decodeURIComponent(c.path.split('?')[0]!.slice('/events/'.length)));
    const before = reads().length;
    const stream = await world().open(await world().person('resumer'), {
      clientId: randomUUID(),
      scoped: [
        { scope: replaying, channels: [PERSISTED], lastEventId: `p-${replaying}-1` },
        { scope: fresh, channels: [PERSISTED] },
        { scope: broken, channels: [PERSISTED], lastEventId: `p-res-elsewhere-3` },
      ],
    });
    await stream.next('the first ping', (m) => m.event === 'ping');
    const events = stream.messages.filter((m) => m.event === 'bus-event');
    expect(events.filter((m) => m.frame?.channel === PERSISTED).map((m) => m.id)).toEqual([`p-${replaying}-2`]);
    expect(stream.frames('bus:resume-gap').map((f) => f.payload)).toEqual([{ reason: 'scope-mismatch', scope: broken, lastSeenId: 'p-res-elsewhere-3' }]);
    expect(reads().slice(before)).toEqual([replaying]);
  });

  it('every subscriber of a channel receives each frame, in the order it was emitted', async () => {
    const token = await world().person('subscriber');
    const first = await world().subscribe(token, { clientId: randomUUID(), global: [BROADCAST] });
    const second = await world().subscribe(await world().person('another'), { clientId: randomUUID(), global: [BROADCAST] });
    const emitter = await world().person('emitter');
    const marks: string[] = Array.from({ length: 5 }, () => randomUUID());
    for (const annotationId of marks) expect((await world().emit(emitter, { channel: BROADCAST, payload: { annotationId } })).status).toBe(202);
    for (const stream of [first, second]) {
      await stream.next('the fifth frame', () => stream.frames(BROADCAST).some((f) => f.payload['annotationId'] === marks[4]));
      expect(stream.frames(BROADCAST).map((f) => f.payload['annotationId']).filter((m) => marks.includes(String(m)))).toEqual(marks);
    }
  });

  it('a frame with no correlationId and no position carries one id on every connection, and no other frame\'s', async () => {
    // One client's two connections, as a handoff overlaps them.
    const token = await world().person('handed-over');
    const clientId = randomUUID();
    const old = await world().subscribe(token, { clientId, global: [BROADCAST] });
    const replacement = await world().subscribe(token, { clientId, global: [BROADCAST] });
    const emitter = await world().person('emitter');
    const marks = [randomUUID(), randomUUID()];
    for (const annotationId of marks) expect((await world().emit(emitter, { channel: BROADCAST, payload: { annotationId } })).status).toBe(202);
    const idsOn = (stream: BusStream) =>
      Promise.all(marks.map(async (mark) => (await stream.next(`the frame marked ${mark}`, (m) => m.frame?.channel === BROADCAST && m.frame.payload['annotationId'] === mark)).id));
    const ids = await idsOn(old);
    expect(await idsOn(replacement)).toEqual(ids);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('a reply reaches only the connections of the client and principal that made the request', async () => {
    const alice = await world().person('alice');
    const bob = await world().person('bob');
    const clientId = randomUUID();
    const requester = await world().subscribe(alice, { clientId, global: [result] });
    const sameClientOtherPerson = await world().subscribe(bob, { clientId, global: [result] });
    const samePersonOtherClient = await world().subscribe(alice, { clientId: randomUUID(), global: [result] });

    const correlationId = randomUUID();
    const reply = await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId });
    expect(reply.status, reply.text).toBe(202);
    const answer = await requester.frame(result, (f) => f.correlationId === correlationId);
    expect(answer.payload['response']).toEqual(describedResult.response);
    await sameClientOtherPerson.quiet(result, 300);
    await samePersonOtherClient.quiet(result, 0);

    // A reply to a request nobody claimed reaches nobody.
    const unclaimed = randomUUID();
    await world().emit(responder.token, { channel: result, payload: describedResult, correlationId: unclaimed });
    await requester.quiet(result, 300, (f) => f.correlationId === unclaimed);
  });

  it('a reply published while its requester was away is recovered by naming it in pendingReplies — by that requester only', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const correlationId = randomUUID();
    const reply = await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId });
    expect(reply.status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));

    const bob = await world().person('bob');
    const stranger = await world().subscribe(bob, { clientId, global: [result], pendingReplies: [correlationId] });
    const otherClient = await world().subscribe(alice, { clientId: randomUUID(), global: [result], pendingReplies: [correlationId] });
    const recovered = await world().subscribe(alice, { clientId, global: [result], pendingReplies: [correlationId] });

    const frame = recovered.frames(result).find((f) => f.correlationId === correlationId);
    expect(frame?.payload['response']).toEqual(describedResult.response);
    expect(stranger.frames(result)).toEqual([]);
    expect(otherClient.frames(result)).toEqual([]);
  });

  it('recovery returns the first reply to a request, and nothing for a correlationId never claimed', async () => {
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const correlationId = randomUUID();
    expect((await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    const second = { response: { ...describedResult.response, resource: { ...describedResult.response.resource, name: 'the second reply' } } };
    expect((await world().emit(responder.token, { channel: result, payload: second, correlationId })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));

    const never = randomUUID();
    const recovered = await world().subscribe(alice, { clientId, global: [result], pendingReplies: [correlationId, never] });
    const replies = recovered.frames(result);
    expect(replies.map((f) => f.correlationId)).toEqual([correlationId]);
    expect(replies[0]?.payload['response']).toEqual(describedResult.response);
  });

  it('a scope\'s persisted events after its watermark are replayed in order, on its channels only, before the live tail', async () => {
    const scope = `res-${randomUUID()}`;
    world().archivist.events.set(scope, [
      storedEvent(PERSISTED, scope, 1),
      storedEvent(PERSISTED, scope, 2),
      storedEvent(PERSISTED, scope, 3),
      storedEvent(OTHER_PERSISTED, scope, 4),
      storedEvent(PERSISTED, scope, 5),
    ]);
    const token = await world().person('resumer');
    const stream = await world().open(token, { clientId: randomUUID(), scoped: [{ scope, channels: [PERSISTED], lastEventId: `p-${scope}-2` }] });
    await stream.next('the first ping', (m) => m.event === 'ping');
    const replayed = stream.messages.filter((m) => m.event === 'bus-event');
    expect(replayed.map((m) => m.id)).toEqual([`p-${scope}-3`, `p-${scope}-5`]);
    expect(replayed.every((m) => m.frame?.scope === scope && m.frame.channel === PERSISTED)).toBe(true);
    expect(replayed[0]?.frame?.payload).toEqual(storedEvent(PERSISTED, scope, 3));

    const fresh = await world().open(token, { clientId: randomUUID(), scoped: [{ scope, channels: [PERSISTED] }] });
    await fresh.next('the first ping', (m) => m.event === 'ping');
    expect(fresh.messages.filter((m) => m.event === 'bus-event')).toEqual([]);
  });

  it('each watermark the gateway cannot honour yields a scoped bus:resume-gap naming why', async () => {
    const token = await world().person('resumer');
    const gap = async (scope: string, lastEventId: string) => {
      const stream = await world().open(token, { clientId: randomUUID(), scoped: [{ scope, channels: [PERSISTED], lastEventId }] });
      await stream.next('the first ping', (m) => m.event === 'ping');
      return stream;
    };

    const unparseable = await gap('res-gap-1', 'not-a-watermark');
    expect(unparseable.frames('bus:resume-gap').map((f) => f.payload)).toEqual([
      { reason: 'unparseable-last-event-id', scope: 'res-gap-1', lastSeenId: 'not-a-watermark' },
    ]);

    const mismatch = await gap('res-gap-2', 'p-res-another-7');
    expect(mismatch.frames('bus:resume-gap').map((f) => f.payload)).toEqual([
      { reason: 'scope-mismatch', scope: 'res-gap-2', lastSeenId: 'p-res-another-7' },
    ]);

    world().archivist.events.set('res-gap-3', [storedEvent(PERSISTED, 'res-gap-3', 6), storedEvent(PERSISTED, 'res-gap-3', 7)]);
    const exceeded = await gap('res-gap-3', 'p-res-gap-3-2');
    const events = exceeded.messages.filter((m) => m.event === 'bus-event');
    expect(events.map((m) => m.frame?.channel)).toEqual(['bus:resume-gap', PERSISTED, PERSISTED]);
    expect(events[0]?.frame?.payload).toEqual({ reason: 'retention-exceeded', scope: 'res-gap-3', lastSeenId: 'p-res-gap-3-2' });
    expect(events.slice(1).map((m) => m.id)).toEqual(['p-res-gap-3-6', 'p-res-gap-3-7']);

    world().archivist.mode.replayFails = true;
    try {
      const failed = await gap('res-gap-4', 'p-res-gap-4-1');
      expect(failed.frames('bus:resume-gap').map((f) => f.payload)).toEqual([
        { reason: 'query-error', scope: 'res-gap-4', lastSeenId: 'p-res-gap-4-1' },
      ]);
    } finally {
      world().archivist.mode.replayFails = false;
    }
  });

  it('an answer the Archivist gives outside its spec is no replay: the scope gets a query-error gap, not a silent skip', async () => {
    const token = await world().person('resumer');
    // An event with no `type`: were it read on trust, it would match no
    // subscribed channel and be dropped without a word.
    const { type: _untyped, ...event } = storedEvent(PERSISTED, 'res-gap-5', 2);
    world().archivist.mode.replayAnswer = { events: [event] };
    try {
      const stream = await world().open(token, { clientId: randomUUID(), scoped: [{ scope: 'res-gap-5', channels: [PERSISTED], lastEventId: 'p-res-gap-5-1' }] });
      await stream.next('the first ping', (m) => m.event === 'ping');
      expect(stream.frames('bus:resume-gap').map((f) => f.payload)).toEqual([
        { reason: 'query-error', scope: 'res-gap-5', lastSeenId: 'p-res-gap-5-1' },
      ]);
      expect(stream.frames(PERSISTED)).toEqual([]);
    } finally {
      world().archivist.mode.replayAnswer = undefined;
    }
    const offSpec = world().archivist.violations.splice(0);
    expect(offSpec).toHaveLength(1);
    expect(offSpec[0]).toMatch(/GET \/events\/res-gap-5: 200 body does not match the declared schema/);
  });

  it('live frames arriving during a replay follow it, less any the replay already delivered', async () => {
    const scope = `res-${randomUUID()}`;
    world().archivist.events.set(scope, [3, 4, 5].map((n) => storedEvent(PERSISTED, scope, n)));
    world().archivist.mode.replayDelayMs = 1_500;
    try {
      const token = await world().person('resumer');
      const stream = await world().open(token, { clientId: randomUUID(), scoped: [{ scope, channels: [PERSISTED], lastEventId: `p-${scope}-2` }] });
      await new Promise((r) => setTimeout(r, 300));
      const emitter = await world().agent('conformance', 'recorder');
      for (const n of [4, 6]) {
        const reply = await world().emit(emitter.token, { channel: PERSISTED, payload: storedEvent(PERSISTED, scope, n), scope });
        expect(reply.status, reply.text).toBe(202);
      }
      await stream.next('the first ping', (m) => m.event === 'ping');
      await stream.next('the live frame', (m) => m.id === `p-${scope}-6`);
      expect(stream.messages.filter((m) => m.event === 'bus-event').map((m) => m.id)).toEqual([3, 4, 5, 6].map((n) => `p-${scope}-${n}`));
    } finally {
      world().archivist.mode.replayDelayMs = 0;
    }
  });

  it('opening a stream publishes session:joined and closing it session:left, naming the principal and the connection', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['session:joined', 'session:left'] });
    const present = await world().subscribe(await world().person('present'), { clientId: randomUUID(), global: [BROADCAST] });
    const joined = await watcher.frame('session:joined', (f) => f.payload['participant'] === world().personDid('present'));
    const connectionId = joined.payload['connectionId'];
    expect(typeof connectionId).toBe('string');
    present.close();
    const left = await watcher.frame('session:left', (f) => f.payload['connectionId'] === connectionId);
    expect(left.payload['participant']).toBe(world().personDid('present'));
  });
});

// Plane-independent, and slow: waits out one heartbeat interval.
eachPlane('the heartbeat', (world) => {
  it('a ping follows the catch-up at once, then one every heartbeatSeconds', async () => {
    const seconds = spec().limits('post', '/bus/subscribe')['heartbeatSeconds']!;
    const opened = Date.now();
    const stream = await world().open(await world().person('idle'), { clientId: randomUUID(), global: [BROADCAST] });
    const first = await stream.next('the first ping', (m) => m.event === 'ping', 5_000);
    expect(first.at - opened).toBeLessThan(2_000);
    const second = await stream.next('the second ping', (m) => m.event === 'ping' && m !== first, (seconds + 5) * 1000);
    expect(second.at - first.at).toBeGreaterThanOrEqual(seconds * 1000 - 500);
    expect(second.at - first.at).toBeLessThan((seconds + 3) * 1000);
  }, 60_000);
}, {}, ['in-process']);

// Plane-independent, and slow: waits out replyRetentionSeconds.
eachPlane('reply retention', (world) => {
  it('a reply is recovered for replyRetentionSeconds, and not after — while its claim still stands', async () => {
    const seconds = spec().limits('post', '/bus/subscribe')['replyRetentionSeconds']!;
    const { result } = operationFor(REQUEST);
    await world().responder([REQUEST], () => ({ channel: result, payload: describedResult }));
    const alice = await world().person('alice');
    const clientId = randomUUID();
    const correlationId = randomUUID();
    expect((await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 500));
    const within = await world().subscribe(alice, { clientId, global: [result], pendingReplies: [correlationId] });
    expect(within.frames(result).map((f) => f.correlationId)).toEqual([correlationId]);
    within.close();

    await new Promise((r) => setTimeout(r, (seconds + 2) * 1000));
    const after = await world().subscribe(alice, { clientId, global: [result], pendingReplies: [correlationId] });
    expect(after.frames(result)).toEqual([]);
    const reclaimed = await world().emit(alice, { channel: REQUEST, payload: { resourceId: 'r' }, correlationId, clientId });
    expect(reclaimed.status).toBe(409);
  }, 120_000);
}, {}, ['in-process']);
