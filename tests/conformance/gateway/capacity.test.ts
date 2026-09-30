/**
 * What one gateway process can hold (GatewayConfig `capacity`): the bytes
 * queued for all its streams together, at which a new stream is refused 503
 * until the queues drain; and the connections it holds open, past which one
 * is closed unanswered. Each case runs a gateway given a small capacity.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nonConformance } from '../harness/http';
import { eventually } from '../harness/net';
import { asReply, stalledSubscriber, subscribe, type BusStream } from '../harness/stream';
import { eachPlane } from '../harness/world';

/** Unvalidated, so its payload can be any size. */
const CHANNEL = 'mark:added';
/** Under the NATS default max_payload (1 MiB) with room for the envelope. */
const FRAME_BYTES = 512 * 1024;
/** Well under one stream's `pendingWriteBytes`, so one stalled reader can fill it. */
const QUEUED_BYTES = 4 * 1024 * 1024;
const CONNECTIONS = 8;

const probe = () => ({ clientId: randomUUID(), global: ['beckon:focus'] });

eachPlane(
  'a gateway whose queued bytes reach its capacity',
  (world) => {
    it('refuses a new stream 503 capacity, told when to return, until the queues drain', async () => {
      const stalled = stalledSubscriber(world().origin, await world().person('stalled'), { clientId: randomUUID(), global: [CHANNEL] });
      const emitter = await world().person('emitter');
      const prober = await world().person('prober');
      const filler = 'x'.repeat(FRAME_BYTES);
      const refused = await eventually('a stream refused at capacity', 30_000, async () => {
        await world().emit(emitter, { channel: CHANNEL, payload: { filler } });
        const reply = await subscribe(world().origin, prober, probe());
        reply.stream?.close();
        return reply.status === 503 ? reply : undefined;
      });
      expect(nonConformance('post', '/bus/subscribe', asReply(refused))).toEqual([]);
      expect((JSON.parse(refused.text!) as { code: string }).code).toBe('capacity');
      stalled.resume();
      const admitted = await eventually('a stream admitted once the queues drained', 15_000, async () => {
        const reply = await subscribe(world().origin, prober, probe());
        if (reply.status === 200) return reply;
        return undefined;
      });
      admitted.stream!.close();
      stalled.close();
    });
  },
  { settings: (s) => ({ ...s, capacity: { queuedBytes: QUEUED_BYTES, connections: 50_000 } }) },
);

eachPlane(
  'a gateway at its connection cap',
  (world) => {
    it('closes a connection past the cap unanswered, and takes one again once one closes', async () => {
      const token = await world().person('many');
      const held: BusStream[] = [];
      let refusal: unknown;
      for (let i = 0; i < CONNECTIONS + 4 && refusal === undefined; i++) {
        try {
          const reply = await subscribe(world().origin, token, probe());
          expect(reply.status, reply.text).toBe(200);
          held.push(reply.stream!);
        } catch (error) {
          refusal = error;
        }
      }
      expect(refusal, 'a connection past the cap is closed unanswered').toBeDefined();
      expect(held.length).toBeLessThanOrEqual(CONNECTIONS);
      held.shift()!.close();
      const again = await eventually('a connection taken once one closed', 10_000, async () => {
        try {
          const reply = await subscribe(world().origin, token, probe());
          return reply.stream;
        } catch {
          return undefined;
        }
      });
      again.close();
      for (const s of held) s.close();
    });
  },
  { settings: (s) => ({ ...s, capacity: { queuedBytes: 1024 * 1024 * 1024, connections: CONNECTIONS } }) },
);
