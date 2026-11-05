/**
 * The bounds on a connection (protocol/contract/TRANSPORT-HTTP.md § Limits).
 * On /bus/subscribe (its `x-semiont-limits`): a client that stops taking
 * frames is disconnected once `pendingWriteBytes` are waiting for it, and a
 * replay that live frames outrun past `replayBufferEvents` is abandoned. A
 * disconnected client is visible on `session:left`. On any connection (the
 * document's `x-semiont-limits`): its first request's head must come whole
 * within `requestHeadSeconds` of its opening; after an answer it is kept
 * `idleConnectionSeconds` for its next request, and a head begun must come
 * whole within `requestHeadSeconds` of its first byte. The close
 * `idleConnectionSeconds` after an answer is too slow to wait out here; the
 * accept loop's own tests hold it on a paused clock
 * (packages/rust/http-service/tests/serve.rs).
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

/**
 * A connection of the case's own to the gateway: what the case writes goes as
 * it is, and what comes back is read as answers, each framed by its
 * Content-Length.
 */
function rawConnection(origin: string) {
  const { hostname, port } = new URL(origin);
  const socket = connect(Number(port), hostname);
  let received = Buffer.alloc(0);
  let framed = true;
  /** Where in `received` the next answer begins. */
  let next = 0;
  const answers: Array<{ status: string; end: number }> = [];
  // A reset is a close too; what is asserted is when, and what came before.
  socket.on('error', () => undefined);
  const opened = new Promise<number>((resolve) => socket.on('connect', () => resolve(Date.now())));
  const closed = new Promise<number>((resolve) => socket.on('close', () => resolve(Date.now())));
  socket.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    while (framed) {
      const head = received.indexOf('\r\n\r\n', next);
      if (head < 0) return;
      const headText = received.subarray(next, head).toString('latin1');
      const length = /\r\ncontent-length: *(\d+)/i.exec(headText);
      if (!length) {
        framed = false;
        return;
      }
      const end = head + 4 + Number(length[1]);
      if (received.length < end) return;
      answers.push({ status: headText.slice(0, 12), end });
      next = end;
    }
  });
  const health = `GET /api/health HTTP/1.1\r\nHost: ${hostname}:${port}\r\n`;
  return {
    /** When the connection was made. */
    opened,
    /** When it was closed, from either side. */
    closed,
    /** Every byte the gateway has written to it. */
    received: () => received,
    /** Ask for /api/health. */
    ask: () => socket.write(`${health}\r\n`),
    /** Write a request's head for /api/health, all but the blank line that ends it; say when. */
    beginHead: () => {
      socket.write(health);
      return Date.now();
    },
    /** The `n`th answer, counted from 1, once it has come whole: its status line, and the byte it ends at. */
    answer: (n: number) =>
      eventually(`answer ${n}`, 10_000, () => {
        expect(framed, `every answer states its Content-Length:\n${received.toString('latin1')}`).toBe(true);
        return answers[n - 1];
      }),
    end: () => socket.end(),
  };
}

/** How long a connection is left idle after its answer before a head begins: long enough that a wait counted from the answer would end clearly sooner than one counted from the head's first byte. */
const IDLE_BEFORE_HEAD_MS = 5_000;

// Plane-independent, and slow: each case waits out requestHeadSeconds.
eachPlane('how long a connection waits', (world) => {
  const headMs = spec().documentLimit('requestHeadSeconds') * 1000;
  const idleMs = spec().documentLimit('idleConnectionSeconds') * 1000;
  /** Past requestHeadSeconds by the margin a close is given: a connection kept only requestHeadSeconds after its answer is closed by then. */
  const pastHeadMs = headMs * 1.3;

  // Less a quarter second in each lower bound: the gateway's wait and the case's clock start a moment apart.
  it('a connection that sends nothing is closed requestHeadSeconds after it opened, with nothing written to it', async () => {
    const connection = rawConnection(world().origin);
    const opened = await connection.opened;
    const end = await connection.closed;
    expect(connection.received().length, 'nothing is written').toBe(0);
    expect(end - opened).toBeGreaterThanOrEqual(headMs - 250);
    expect(end - opened).toBeLessThan(headMs * 1.3);
  }, headMs * 2 + 10_000);

  it('after an answer, a request sent past requestHeadSeconds later is answered on the same connection', async () => {
    expect(idleMs, 'idleConnectionSeconds outlasts the wait').toBeGreaterThan(pastHeadMs + 5_000);
    const connection = rawConnection(world().origin);
    connection.ask();
    expect((await connection.answer(1)).status).toBe('HTTP/1.1 200');
    await new Promise((r) => setTimeout(r, pastHeadMs));
    connection.ask();
    expect((await connection.answer(2)).status).toBe('HTTP/1.1 200');
    connection.end();
  }, pastHeadMs + 30_000);

  it('after an answer, a head begun and left unfinished is closed requestHeadSeconds after its first byte, with nothing more written', async () => {
    const connection = rawConnection(world().origin);
    connection.ask();
    const answered = await connection.answer(1);
    expect(answered.status).toBe('HTTP/1.1 200');
    await new Promise((r) => setTimeout(r, IDLE_BEFORE_HEAD_MS));
    const begun = connection.beginHead();
    const end = await connection.closed;
    expect(connection.received().length, 'nothing is written after the answer').toBe(answered.end);
    expect(end - begun).toBeGreaterThanOrEqual(headMs - 250);
    expect(end - begun).toBeLessThan(headMs * 1.3);
  }, IDLE_BEFORE_HEAD_MS + headMs * 2 + 20_000);
}, {}, ['in-process']);
