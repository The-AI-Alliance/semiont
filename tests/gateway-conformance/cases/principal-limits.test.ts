/**
 * What one principal may take (`x-semiont-limits` on /bus/subscribe and
 * /bus/emit): a baseline, and a coefficient per role. A person and an agent
 * are indistinguishable here — the same case runs for each, and each must
 * behave alike; only a role changes the coefficient, whoever holds it.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nonConformance, type Reply } from '../harness/http';
import { eventually } from '../harness/net';
import { SERVICE_ROLE, WORKER_ROLE } from '../harness/roles';
import { spec } from '../harness/spec';
import { asReply, subscribe, type BusStream } from '../harness/stream';
import { eachPlane, type World } from '../harness/world';

interface EmitRate {
  perSecond: number;
  burst: number;
}

const emitLimit = () => spec().principalLimit<EmitRate>('post', '/bus/emit', 'emitsPerPrincipal');
const streamLimit = () => spec().principalLimit<number>('post', '/bus/subscribe', 'streamsPerPrincipal');

/** A subscription body, a fresh client each time. */
const stream = () => ({ clientId: randomUUID(), global: ['beckon:focus'] });

/** A principal holding no role, of each kind. */
const unroled = async (world: World): Promise<Array<[string, string]>> => [
  ['a person', await world.person(`limits-person-${Math.random()}`)],
  ['an agent', (await world.agent('limits', `model-${Math.random()}`, [SERVICE_ROLE])).token],
];

/** `count` emits at once. */
const burst = (world: World, token: string, count: number): Promise<Reply[]> =>
  Promise.all(Array.from({ length: count }, () => world.emit(token, { channel: 'beckon:focus', payload: {} })));

eachPlane('what one principal may take', (world) => {
  it('past its emit bucket a principal holding no role is refused 429 emit-rate, told when to return, and admitted then — a person and an agent alike', async () => {
    const { baseline } = emitLimit();
    for (const [kind, token] of await unroled(world())) {
      // Rounds of a full burst each, until one is refused: the bucket refills
      // while a round is in flight, so no single count is sure to empty it.
      const replies: Reply[] = [];
      for (let round = 0; round < 5 && !replies.some((r) => r.status === 429); round++) {
        replies.push(...(await burst(world(), token, baseline.burst)));
      }
      const accepted = replies.filter((r) => r.status === 202);
      const refused = replies.filter((r) => r.status === 429);
      expect(accepted.length + refused.length, `${kind}: every emit accepted or refused`).toBe(replies.length);
      expect(accepted.length, `${kind}: the bucket starts full`).toBeGreaterThanOrEqual(baseline.burst);
      expect(refused.length, `${kind}: refused past the burst`).toBeGreaterThan(0);
      for (const reply of refused.slice(0, 3)) {
        expect(nonConformance('post', '/bus/emit', reply), kind).toEqual([]);
        expect((reply.json as { code: string }).code, kind).toBe('emit-rate');
      }
      const wait = Number(refused.at(-1)!.headers.get('retry-after'));
      expect(wait, `${kind}: Retry-After`).toBeGreaterThanOrEqual(1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      const after = await world().emit(token, { channel: 'beckon:focus', payload: {} });
      expect(after.status, `${kind}: admitted after Retry-After`).toBe(202);
    }
  });

  it('a principal holding no role holds at most its baseline of streams: the next is refused 429 streams, told when to return, and closing one admits one — a person and an agent alike', async () => {
    const { baseline } = streamLimit();
    for (const [kind, token] of await unroled(world())) {
      const held: BusStream[] = [];
      for (let i = 0; i < baseline; i++) held.push(await world().subscribe(token, stream()));
      const over = await subscribe(world().origin, token, stream());
      over.stream?.close();
      expect(over.status, kind).toBe(429);
      expect(nonConformance('post', '/bus/subscribe', asReply(over)), kind).toEqual([]);
      expect((JSON.parse(over.text!) as { code: string }).code, kind).toBe('streams');
      held[0]!.close();
      const again = await eventually(`${kind}: a stream admitted once one closed`, 10_000, async () => {
        const reply = await subscribe(world().origin, token, stream());
        if (reply.status === 200) return reply;
        return undefined;
      });
      again.stream!.close();
      for (const s of held) s.close();
    }
  });

  it('a principal holding an unlimited role holds more streams than the baseline, whatever its kind', async () => {
    const { baseline, roles } = streamLimit();
    expect(roles[SERVICE_ROLE]).toBe('unlimited');
    expect(roles[WORKER_ROLE]).toBe('unlimited');
    const holders: Array<[string, string]> = [
      ['a person holding the service role', await world().person(`streams-service-${Math.random()}`, { roles: [SERVICE_ROLE] })],
      ['an agent holding the worker role', (await world().agent('streams', `worker-${Math.random()}`, [SERVICE_ROLE, WORKER_ROLE])).token],
    ];
    for (const [kind, token] of holders) {
      const held: BusStream[] = [];
      for (let i = 0; i <= baseline; i++) held.push(await world().subscribe(token, stream()));
      expect(held.length, kind).toBe(baseline + 1);
      for (const s of held) s.close();
    }
  });

  it('a principal holding an unlimited role is not limited by its emit bucket, whatever its kind', async () => {
    const { baseline, roles } = emitLimit();
    expect(roles[SERVICE_ROLE]).toBe('unlimited');
    expect(roles[WORKER_ROLE]).toBe('unlimited');
    const holders: Array<[string, string]> = [
      ['a person holding the service role', await world().person(`limits-service-${Math.random()}`, { roles: [SERVICE_ROLE] })],
      ['an agent holding the worker role', (await world().agent('limits', `worker-${Math.random()}`, [SERVICE_ROLE, WORKER_ROLE])).token],
    ];
    for (const [kind, token] of holders) {
      const replies = [...(await burst(world(), token, baseline.burst)), ...(await burst(world(), token, baseline.burst))];
      expect(replies.filter((r) => r.status !== 202).map((r) => r.status), kind).toEqual([]);
    }
  });
});
