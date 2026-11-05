/**
 * The bounds on a connection (protocol/contract/TRANSPORT-HTTP.md § Limits).
 * On /bus/subscribe (its `x-semiont-limits`): a client that stops taking
 * frames is disconnected once `pendingWriteBytes` are waiting for it, and a
 * replay that live frames outrun past `replayBufferEvents` is abandoned. A
 * disconnected client is visible on `session:left`. On any connection (the
 * document's `x-semiont-limits`): one that sends no request is closed
 * `requestHeadSeconds` after its last answer.
 */
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { expect, it } from 'vitest';
import { storedEvent } from '../harness/archivist';
import { eventually } from '../harness/net';
import { SERVICE_ROLE, WORKER_ROLE } from '../harness/roles';
import { spec } from '../harness/spec';
import { stalledSubscriber } from '../harness/stream';
import { eachPlane } from '../harness/world';

/** Unvalidated, so its payload can be any size. */
const CHANNEL = 'mark:added';
/** Well under the largest emit the gateway and the broker take. */
const FRAME_BYTES = 512 * 1024;

eachPlane('connection bounds', (world) => {
  it('a subscriber that stops reading is disconnected once pendingWriteBytes are waiting for it; one that reads is not', async () => {
    const limit = spec().limits('post', '/bus/subscribe')['pendingWriteBytes']!;
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['session:joined', 'session:left'] });
    const reader = await world().subscribe(await world().person('reader'), { clientId: randomUUID(), global: [CHANNEL] });

    const stalledToken = await world().person('stalled');
    const stalled = stalledSubscriber(world().origin, stalledToken, { clientId: randomUUID(), global: [CHANNEL] });
    const joined = await watcher.frame('session:joined', (f) => f.payload['participant'] === world().personDid('stalled'));

    const emitter = await world().agent('flood');
    const filler = 'x'.repeat(FRAME_BYTES);
    // Twice the bound, plus room for what the operating system buffers.
    const frames = Math.ceil((2 * limit) / FRAME_BYTES) + 16;
    let left = false;
    let emitted = 0;
    for (; emitted < frames && !left; emitted++) {
      const reply = await world().emit(emitter.token, { channel: CHANNEL, payload: { n: emitted, filler } });
      expect(reply.status, reply.text).toBe(202);
      left = watcher.frames('session:left').some((f) => f.payload['connectionId'] === joined.payload['connectionId']);
    }
    await watcher.frame('session:left', (f) => f.payload['connectionId'] === joined.payload['connectionId'], 20_000);
    await stalled.drain();

    await eventually('the reader to take every frame', 30_000, () => (reader.frames(CHANNEL).length === emitted ? true : undefined));
    expect(reader.closed).toBe(false);
  }, 120_000);

  it('a replay that more than replayBufferEvents live frames outrun is abandoned; exactly that many are delivered after it', async () => {
    const limit = spec().limits('post', '/bus/subscribe')['replayBufferEvents']!;
    // A worker's role makes its emits unlimited: the flood is the replay's
    // bound to meet, not this principal's emit bucket.
    const emitter = await world().agent('outrunner', [SERVICE_ROLE, WORKER_ROLE]);
    const token = await world().person('resumer');

    const run = async (live: number) => {
      const scope = `res-${randomUUID()}`;
      world().archivist.events.set(scope, [storedEvent(CHANNEL, scope, 2)]);
      world().archivist.mode.replayDelayMs = 8_000;
      const stream = await world().open(token, { clientId: randomUUID(), scoped: [{ scope, channels: [CHANNEL], lastEventId: `p-${scope}-1` }] });
      await new Promise((r) => setTimeout(r, 300));
      const emits: Array<Promise<unknown>> = [];
      for (let i = 0; i < live; i++) {
        emits.push(world().emit(emitter.token, { channel: CHANNEL, payload: { n: i }, scope }));
        if (emits.length >= 32) await Promise.all(emits.splice(0));
      }
      await Promise.all(emits);
      world().archivist.mode.replayDelayMs = 0;
      return stream;
    };

    const within = await run(limit);
    await eventually('every live frame after the replay', 30_000, () => (within.frames(CHANNEL).length === limit + 1 ? true : undefined));
    expect(within.closed).toBe(false);

    const over = await run(limit + 1);
    await over.ends(30_000);
    expect(over.frames(CHANNEL).length).toBeLessThan(limit + 2);
  }, 120_000);
});

eachPlane('an idle connection', (world) => {
  const limitMs = spec().documentLimit('requestHeadSeconds') * 1000;

  it('is closed requestHeadSeconds after its last answer, with nothing written to it', async () => {
    const { hostname, port } = new URL(world().origin);
    const socket = connect(Number(port), hostname);
    let received = Buffer.alloc(0);
    let answerBytes: number | undefined;
    let answered: number | undefined;
    // A reset is a close too; what is asserted is when, and what came before.
    socket.on('error', () => undefined);
    const closed = new Promise<number>((resolve) => socket.on('close', () => resolve(Date.now())));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const head = received.indexOf('\r\n\r\n');
      if (answerBytes === undefined && head >= 0) {
        const length = /\r\ncontent-length: *(\d+)/i.exec(received.subarray(0, head).toString('latin1'));
        answerBytes = length ? head + 4 + Number(length[1]) : Number.NaN;
      }
      if (answered === undefined && answerBytes !== undefined && received.length >= answerBytes) answered = Date.now();
    });
    socket.write(`GET /api/health HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`);

    const end = await closed;
    expect(received.subarray(0, 12).toString('latin1'), received.toString('latin1')).toBe('HTTP/1.1 200');
    expect(answerBytes, 'the answer states its Content-Length').not.toBeNaN();
    expect(answered, 'the answer came whole').toBeDefined();
    expect(received.length, 'nothing is written after the answer').toBe(answerBytes);
    // Less a quarter second: the gateway's wait began as it wrote the answer, a little before it arrived.
    expect(end - answered!).toBeGreaterThanOrEqual(limitMs - 250);
    expect(end - answered!).toBeLessThan(limitMs * 1.3);
  }, limitMs * 2 + 10_000);
}, {}, ['in-process']);
