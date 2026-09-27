/**
 * The two bounds on a connection (`x-semiont-limits` on /bus/subscribe;
 * docs/protocol/TRANSPORT-HTTP.md § Limits): a client that stops taking
 * frames is disconnected once `pendingWriteBytes` are waiting for it, and a
 * replay that live frames outrun past `replayBufferEvents` is abandoned. A
 * disconnected client is visible on `session:left`.
 */
import { randomUUID } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { expect, it } from 'vitest';
import { storedEvent } from '../harness/archivist';
import { eventually } from '../harness/net';
import { spec } from '../harness/spec';
import { eachPlane } from '../harness/world';

/** Unvalidated, so its payload can be any size. */
const CHANNEL = 'mark:added';
/** Under the NATS default max_payload (1 MiB) with room for the envelope. */
const FRAME_BYTES = 512 * 1024;

/**
 * A subscriber that opens the stream and stops reading. `drain()` starts
 * reading again and resolves once the stream has ended — a socket that is
 * not being read cannot see its peer close it.
 */
function stalledSubscriber(origin: string, token: string, body: unknown): { drain(): Promise<void> } {
  const url = new URL('/bus/subscribe', origin);
  let ended: () => void;
  const end = new Promise<void>((resolve) => {
    ended = resolve;
  });
  let response: IncomingMessage | undefined;
  const req = request(
    { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
    (res) => {
      response = res;
      res.pause();
      res.on('end', () => ended());
      res.on('close', () => ended());
      res.on('error', () => ended());
    },
  );
  req.on('error', () => ended());
  req.end(JSON.stringify(body));
  return {
    drain() {
      response?.resume();
      return end;
    },
  };
}

eachPlane('connection bounds', (world) => {
  it('a subscriber that stops reading is disconnected once pendingWriteBytes are waiting for it; one that reads is not', async () => {
    const limit = spec().limits('post', '/bus/subscribe')['pendingWriteBytes']!;
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['session:joined', 'session:left'] });
    const reader = await world().subscribe(await world().person('reader'), { clientId: randomUUID(), global: [CHANNEL] });

    const stalledToken = await world().person('stalled');
    const stalled = stalledSubscriber(world().origin, stalledToken, { clientId: randomUUID(), global: [CHANNEL] });
    const joined = await watcher.frame('session:joined', (f) => f.payload['participant'] === world().personDid('stalled'));

    const emitter = await world().agent('conformance', 'flood');
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
    const emitter = await world().agent('conformance', 'outrunner');
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
