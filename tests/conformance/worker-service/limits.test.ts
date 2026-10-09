/**
 * The limits a worker answers (WORKER-SERVICE.md § Limits): one reply to
 * `job:limits-requested`, from its first agent, with what each of its models
 * can take as its provider states it.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { marks, YIELDS } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { eachWorkerService, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';
import { CONTEXT_LENGTH } from './support';

/** Ask for the limits as a client does, and read the one reply. */
async function limits(w: WorkerServiceWorld): Promise<{ payload: Record<string, unknown>; by: unknown }> {
  const listener = await w.listen(['job:limits-result', 'job:limits-failed']);
  const correlationId = randomUUID();
  const reply = await w.world.emit(listener.token, { channel: 'job:limits-requested', payload: {}, correlationId, clientId: listener.clientId });
  expect(reply.status).toBe(202);
  const message = await listener.stream.next('the limits', (m) => m.frame?.correlationId === correlationId, 15_000);
  const { _userId: by, ...payload } = Object.fromEntries(Object.entries(message.frame!.payload).filter(([key]) => key === '_userId' || !key.startsWith('_')));
  expect(message.frame!.channel).toBe('job:limits-result');
  return { payload, by };
}

/** A window of `contextTokens`, as an Ollama model's is stated: one window, shared by what goes in and what comes out. */
const shared = (contextTokens: number) => ({ contextTokens, maxOutputTokens: contextTokens, acceptsTemperature: true });

async function started(w: WorkerServiceWorld): Promise<Served> {
  const [first, second] = w.agents;
  const served = await w.start({ agents: [w.entry(first!, [marks('highlighting')]), w.entry(second!, [YIELDS])] });
  await eventually('both agents to have claimed', 15_000, () => (w.claims.length >= 2 ? true : undefined));
  return served;
}

eachWorkerService('the limits a worker answers', (world) => {
  it('answers a request once, from its first agent, with the limits of every provider and model it works as, in the order of its agents', async () => {
    const w = world();
    const [first, second] = w.agents;
    const served = await started(w);
    const answer = await limits(w);
    expect(answer.payload).toEqual({
      response: {
        limits: [
          { provider: first!.provider, model: first!.model, limits: shared(CONTEXT_LENGTH) },
          { provider: second!.provider, model: second!.model, limits: shared(CONTEXT_LENGTH) },
        ],
      },
    });
    expect(answer.by).toBe(first!.did);
    // It asked its provider of each model once, by name.
    expect([...(w.ollama.shows as Array<{ model: string }>)].sort((a, b) => (a.model < b.model ? -1 : 1))).toEqual(
      [{ model: first!.model }, { model: second!.model }].sort((a, b) => (a.model < b.model ? -1 : 1)),
    );
    expect(served.emits('job:limits-result').map((e) => e.by)).toEqual([first!.did]);
    expect(served.emits('job:limits-failed')).toEqual([]);
  });

  it('remembers what a provider said, and asks it again only for a model it could not learn of', async () => {
    const w = world();
    const [first, second] = w.agents;
    await started(w);

    // A provider that cannot be asked: its models are left out, and the request is still answered.
    w.ollama.show = { status: 500 };
    expect((await limits(w)).payload).toEqual({ response: { limits: [] } });

    // It is asked again at the next request.
    w.ollama.show = { contextLength: 4096 };
    const learned = {
      response: {
        limits: [
          { provider: first!.provider, model: first!.model, limits: shared(4096) },
          { provider: second!.provider, model: second!.model, limits: shared(4096) },
        ],
      },
    };
    expect((await limits(w)).payload).toEqual(learned);

    // What it learned it keeps: the provider is not asked a third time.
    w.ollama.show = { contextLength: 2048 };
    const asked = w.ollama.shows.length;
    expect((await limits(w)).payload).toEqual(learned);
    expect(w.ollama.shows.length).toBe(asked);
  });
});
