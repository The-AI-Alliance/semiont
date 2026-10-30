/**
 * The limits a worker answers (WORKER-SERVICE.md § Limits): one reply to
 * `job:limits-requested`, with what each of its engines' models can take as
 * its provider states it.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { marks, YIELDS } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { ANTHROPIC_MODEL, eachWorkerService, type Engine, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';
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

/** A worker of two engines, the first two of `engines`: one used for highlighting and one for generation. */
async function started(w: WorkerServiceWorld, engines: readonly Engine[]): Promise<Served> {
  const [first, second] = engines;
  const served = await w.start({ engines: [w.entry(first!, [marks('highlighting')]), w.entry(second!, [YIELDS])] });
  await eventually('both engines to have claimed', 15_000, () => (w.claims.length >= 2 ? true : undefined));
  return served;
}

eachWorkerService('the limits a worker answers', (world) => {
  it('answers a request once, as the agent, with the limits of every engine, in the order of its engines', async () => {
    const w = world();
    const [first, second] = w.engines;
    const served = await started(w, w.engines);
    const answer = await limits(w);
    expect(answer.payload).toEqual({
      response: {
        limits: [
          { engine: { provider: first!.provider, model: first!.model }, limits: shared(CONTEXT_LENGTH) },
          { engine: { provider: second!.provider, model: second!.model }, limits: shared(CONTEXT_LENGTH) },
        ],
      },
    });
    expect(answer.by).toBe(w.did);
    // It asked its provider of each model once, by name.
    expect([...(w.ollama.shows as Array<{ model: string }>)].sort((a, b) => (a.model < b.model ? -1 : 1))).toEqual(
      [{ model: first!.model }, { model: second!.model }].sort((a, b) => (a.model < b.model ? -1 : 1)),
    );
    expect(served.emits('job:limits-result').map((e) => e.by)).toEqual([w.did]);
    expect(served.emits('job:limits-failed')).toEqual([]);
  });

  it('remembers what a provider said, and asks it again only for a model it could not learn of', async () => {
    const w = world();
    const [first, second] = w.engines;
    await started(w, w.engines);

    // A provider that cannot be asked: its models are left out, and the request is still answered.
    w.ollama.show = { status: 500 };
    expect((await limits(w)).payload).toEqual({ response: { limits: [] } });

    // It is asked again at the next request.
    w.ollama.show = { contextLength: 4096 };
    const learned = {
      response: {
        limits: [
          { engine: { provider: first!.provider, model: first!.model }, limits: shared(4096) },
          { engine: { provider: second!.provider, model: second!.model }, limits: shared(4096) },
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

  it('answers, of an Anthropic model, what its provider says it reads and writes, and that it takes no temperature, having asked of each model once and in one request', async () => {
    const w = world();
    const [first, second] = w.anthropicEngines;
    // The second reads and writes less.
    w.anthropic.models.set(second!.model, { maxInputTokens: 180_000, maxOutputTokens: 8192, structuredOutputs: true });
    await started(w, w.anthropicEngines);
    const stated = {
      response: {
        limits: [
          { engine: { provider: first!.provider, model: first!.model }, limits: { contextTokens: ANTHROPIC_MODEL.maxInputTokens, maxOutputTokens: ANTHROPIC_MODEL.maxOutputTokens, acceptsTemperature: false } },
          { engine: { provider: second!.provider, model: second!.model }, limits: { contextTokens: 180_000, maxOutputTokens: 8192, acceptsTemperature: false } },
        ],
      },
    };
    const answer = await limits(w);
    expect(answer.payload).toEqual(stated);
    expect(answer.by).toBe(w.did);

    // Of each model, its ceilings, and nothing else. The two engines ask at once, so the two requests come in no fixed order.
    expect(w.anthropic.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual([`GET /v1/models/${first!.model}`, `GET /v1/models/${second!.model}`].sort());

    // What it learned it keeps: the provider is asked nothing more.
    expect((await limits(w)).payload).toEqual(stated);
    expect(w.anthropic.requests).toHaveLength(2);
  });
});
