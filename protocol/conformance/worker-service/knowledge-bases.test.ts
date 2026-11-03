/**
 * A worker of two knowledge bases (WORKER-SERVICE.md § The agent,
 * § Knowledge bases, § Health): at each it signs in as the client its document
 * names there, asks which knowledge base it reached, says what it is called
 * and runs the jobs that knowledge base hands it, as the agent it is there;
 * one that answers as another, or refuses it, is refused alone; one whose
 * stream drops keeps its work there, and one in trouble is started again
 * alone; and its health answers once one is confirmed.
 */
import { expect, it } from 'vitest';
import { marks } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import type { GrantFailure } from '../harness/issuer';
import { clientTiming } from '../harness/spec';
import { eachWorkerService, SECOND_WORKER_CLIENT, WORKER_CLIENT, type Confirmation, type Served, type StandInKnowledgeBase, type WorkerServiceWorld } from '../harness/worker-service-world';
import { health, IDLE, KB_LOG, logged, markJob, settled, type WorkerKnowledgeBaseHealth } from './support';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The id of the job the first engine of a knowledge base holds, as `GET /health` says it. */
const heldBy = (kb: WorkerKnowledgeBaseHealth): string | undefined => kb.engines![0]!.activeJob?.jobId;

/** Whether the worker's health gives any answer within `ms`, asked again and again, as whatever supervises it asks. */
async function healthAnswersWithin(served: Served, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const answered = await Promise.race([served.process.http('GET', '/health').then(() => true, () => false), sleep(deadline - Date.now()).then(() => false)]);
    if (answered) return true;
    await sleep(100);
  }
  return false;
}

/** Once its confirmation has been asked for, a knowledge base answers only when `release` is called. */
function holdConfirmation(kb: StandInKnowledgeBase): () => void {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  kb.hooks.confirm = async () => {
    await released;
    return undefined;
  };
  return release;
}

/**
 * A worker of the world's knowledge base and the second, one engine at each,
 * each used for highlighting: the world's first engine at the world's, its
 * second at the second.
 */
async function servingBoth(w: WorkerServiceWorld, second: StandInKnowledgeBase, how: { client?: string; spawn?: true } = {}): Promise<Served> {
  const [here, there] = w.engines;
  const options = {
    engines: [w.entry(here!, [marks('highlighting')])],
    serving: [{ kb: second, engines: [w.entry(there!, [marks('highlighting')])], ...(how.client ? { client: how.client } : {}) }],
  };
  return how.spawn ? w.spawn(options) : w.start(options);
}

/** Each knowledge base's sign-ins, by the DID the gateway named the worker by. */
const signedInAs = (served: Served, kbs: StandInKnowledgeBase[]): string[][] => kbs.map((kb) => served.at(kb).signIns().map(({ did }) => did));

eachWorkerService('a worker of two knowledge bases', (world) => {
  it('signs in at each knowledge base once, as the client its document names there, and is named at each by that gateway', async () => {
    const w = world();
    const second = await w.second();
    const grants = [w.world.issuer.grants.get(WORKER_CLIENT) ?? 0, second.world.issuer.grants.get(SECOND_WORKER_CLIENT) ?? 0];
    const served = await servingBoth(w, second);
    await eventually('both knowledge bases to have been claimed at', 15_000, () => (w.claims.length >= 1 && second.claims.length >= 1 ? true : undefined));
    expect(signedInAs(served, [w, second])).toEqual([[w.did], [second.did]]);
    expect([w.world.issuer.grants.get(WORKER_CLIENT) ?? 0, second.world.issuer.grants.get(SECOND_WORKER_CLIENT) ?? 0]).toEqual([grants[0]! + 1, grants[1]! + 1]);
    // One stream at each, opened as the agent it is there.
    expect([w, second].map((kb) => served.at(kb).streams().map(({ by }) => by))).toEqual([[w.did], [second.did]]);
  });

  it('asks each knowledge base which it is, once, on the stream it opened there, and is confirmed by the domain its document names, saying so in its log', async () => {
    const w = world();
    const second = await w.second();
    const served = await servingBoth(w, second);
    await eventually('both knowledge bases to have been claimed at', 15_000, () => (w.claims.length >= 1 && second.claims.length >= 1 ? true : undefined));
    for (const kb of [w, second]) {
      const at = served.at(kb);
      expect(at.emits('browse:kb-requested').map(({ by, payload, scope, status }) => ({ by, payload, scope, status })), kb.domain).toEqual([{ by: kb.did, payload: {}, scope: undefined, status: 202 }]);
      // Asked once the stream is open, so that the answer comes back on it.
      const [stream] = at.proxy.requests.filter((r) => r.path === '/bus/subscribe');
      expect(stream!.answered! < at.emits('browse:kb-requested')[0]!.arrived, kb.domain).toBe(true);
    }
    const confirmed = logged(served.process.stdout, KB_LOG.confirmed).map(({ level, domain, did }) => ({ level, domain, did }));
    expect([...confirmed].sort((a, b) => (String(a.domain) < String(b.domain) ? -1 : 1))).toEqual(
      [{ level: 'info', domain: w.domain, did: w.did }, { level: 'info', domain: second.domain, did: second.did }].sort((a, b) => (a.domain < b.domain ? -1 : 1)),
    );
  });

  it('says at each knowledge base, once it is confirmed and before it claims there, that it is called by the client its document names there', async () => {
    const w = world();
    const second = await w.second();
    const served = await servingBoth(w, second);
    await eventually('both knowledge bases to have been claimed at', 15_000, () => (w.claims.length >= 1 && second.claims.length >= 1 ? true : undefined));
    for (const [kb, client] of [[w, WORKER_CLIENT], [second, SECOND_WORKER_CLIENT]] as const) {
      const at = served.at(kb);
      expect(at.emits('principal:profile').map(({ by, payload, scope, status }) => ({ by, payload, scope, status })), kb.domain).toEqual([{ by: kb.did, payload: { name: client }, scope: undefined, status: 202 }]);
      const [asked] = at.emits('browse:kb-requested');
      const answer = at.carried('browse:kb-result').find((c) => c.frame.correlationId === asked!.correlationId);
      const [profile] = at.emits('principal:profile');
      const [claim] = at.emits('job:claim');
      expect([answer!.at < profile!.arrived, profile!.arrived < claim!.arrived], kb.domain).toEqual([true, true]);
    }
  });

  it('runs the job each knowledge base hands it on the engine that claimed it there, and attributes what it makes to the agent it is at that knowledge base and to that engine', async () => {
    const w = world();
    const second = await w.second();
    const [here, there] = w.engines;
    const jobs = [markJob(w, 'here', { motivation: 'highlighting' }), markJob(second, 'there', { motivation: 'highlighting' })];
    // The two knowledge bases' engines work at once, so the provider answers by which model asked.
    w.ollama.choose = (body) => ({ response: JSON.stringify([{ exact: body['model'] === here!.model ? 'the first program' : 'Charles Babbage' }]) });
    const served = await servingBoth(w, second);
    for (const [kb, job, engine] of [[w, jobs[0]!, here!], [second, jobs[1]!, there!]] as const) {
      await settled(served.at(kb), job);
      // It was claimed there, as the agent there, and everything said of it was said there, by that agent.
      expect(kb.claims.filter((c) => c.answered !== undefined).map(({ by, answered }) => ({ by, answered })), kb.domain).toEqual([{ by: kb.did, answered: job.metadata.id }]);
      const said = served.at(kb).emits().filter((e) => e.payload['jobId'] === job.metadata.id);
      expect(said.length, kb.domain).toBeGreaterThan(0);
      expect([...new Set(said.map((e) => e.by))], kb.domain).toEqual([kb.did]);
      // What it made names the agent by its DID there, and the engine.
      expect(kb.commits.map((c) => ({ by: c.by, resourceId: c.resourceId })), kb.domain).toEqual([{ by: kb.did, resourceId: job.params.resourceId }]);
      expect(kb.commits[0]!.annotations.map((a) => a.generator), kb.domain).toEqual([kb.generator(engine)]);
    }
    expect(w.ollama.generations.map((g) => g.body['model']).sort()).toEqual([here!.model, there!.model].sort());
  });

  it('answers GET /health with each knowledge base in the order of its document: each working, with the DID it is named by there and the engines it runs there', async () => {
    const w = world();
    const second = await w.second();
    const [here, there] = w.engines;
    const served = await servingBoth(w, second);
    await eventually('both knowledge bases to have been confirmed', 15_000, async () => ((await health(served.process)).knowledgeBases.every((kb) => kb.state === 'working') ? true : undefined));
    expect(await health(served.process)).toEqual({
      status: 'ok',
      knowledgeBases: [
        { domain: w.domain, state: 'working', did: w.did, engines: [{ engine: { provider: here!.provider, model: here!.model }, jobs: [marks('highlighting')], ...IDLE }] },
        { domain: second.domain, state: 'working', did: second.did, engines: [{ engine: { provider: there!.provider, model: there!.model }, jobs: [marks('highlighting')], ...IDLE }] },
      ],
    });
  });

  it.each<[string, (w: WorkerServiceWorld) => Confirmation]>([
    // The world's own domain: the gateway the second entry names is another knowledge base's.
    ['answers as another knowledge base', (w) => ({ domain: w.domain })],
    ['answers browse:kb-failed', () => ({ failure: 'This knowledge base declares no domain' })],
  ])('refuses a knowledge base that %s, saying so once in its log, says nothing more there, does not sign in there again, and works at the other', async (_what, answer) => {
    const w = world();
    const second = await w.second();
    const confirmation = answer(w);
    second.hooks.confirm = () => confirmation;
    const served = await servingBoth(w, second);
    const there = served.at(second);
    const refusedAt = await eventually('the refusal in its log', 15_000, () => (logged(served.process.stdout, KB_LOG.refused).length > 0 ? Date.now() : undefined));
    expect(logged(served.process.stdout, KB_LOG.refused)).toEqual([expect.objectContaining({ level: 'error', domain: second.domain, reason: expect.any(String) })]);
    // Its stream there is closed, and nothing was said there after the question: no name, no claim.
    await there.proxy.until('its stream there to end', () => (there.streams().every((s) => s.closed) ? true : undefined), 15_000);
    expect(there.emits().map(({ channel }) => channel)).toEqual(['browse:kb-requested']);
    expect(second.claims).toEqual([]);
    expect((await health(served.process)).knowledgeBases).toEqual([
      expect.objectContaining({ domain: w.domain, state: 'working', did: w.did }),
      { domain: second.domain, state: 'refused' },
    ]);

    // The other knowledge base works as it would alone.
    const job = markJob(w, 'beside-a-refusal', { motivation: 'highlighting' });
    w.ollama.script({ response: '[]' });
    await w.announce(job);
    await settled(served, job);

    // Longer than a knowledge base in trouble waits before it is started again: the refused one is not.
    await sleep(Math.max(0, refusedAt + clientTiming('reconnectMs') + 1000 - Date.now()));
    expect(there.signIns()).toHaveLength(1);
    expect(there.streams()).toHaveLength(1);
    expect(logged(served.process.stdout, KB_LOG.refused)).toHaveLength(1);
    // Nothing it wrote carries its key or a token it was granted.
    for (const secret of [w.env.SEMIONT_OIDC_CLIENT_KEY!, ...served.tokens(), ...there.tokens()]) expect(served.process.output.join('\n')).not.toContain(secret);
  });

  it('refuses a knowledge base whose issuer refuses its sign-in, saying so once in its log, and works at the other', async () => {
    const w = world();
    const second = await w.second();
    // A client the second issuer does not hold.
    const served = await servingBoth(w, second, { client: 'semiont-worker-unregistered' });
    await eventually('the refusal in its log', 15_000, () => (logged(served.process.stdout, KB_LOG.refused).length > 0 ? true : undefined));
    expect(logged(served.process.stdout, KB_LOG.refused)).toEqual([expect.objectContaining({ level: 'error', domain: second.domain, reason: expect.any(String) })]);
    // It got no token there, so it asked that gateway nothing.
    expect(served.at(second).proxy.requests).toEqual([]);
    expect((await health(served.process)).knowledgeBases).toEqual([
      expect.objectContaining({ domain: w.domain, state: 'working', did: w.did }),
      { domain: second.domain, state: 'refused' },
    ]);
    const job = markJob(w, 'beside-an-issuer-refusal', { motivation: 'highlighting' });
    w.ollama.script({ response: '[]' });
    await w.announce(job);
    await settled(served, job);
    expect(served.process.output.join('\n')).not.toContain(w.env.SEMIONT_OIDC_CLIENT_KEY!);
  });

  it('keeps its work at a knowledge base whose stream drops: it opens the stream again with the bearer it holds, is not started again there, and goes on claiming, while the other keeps its stream and the job it holds', async () => {
    const w = world();
    const second = await w.second();
    const reconnectMs = clientTiming('reconnectMs');
    const [, theirs] = w.engines;
    // The second knowledge base's job is held at its model throughout; whatever the world's asks is answered.
    const held = markJob(second, 'kept-through-a-drop', { motivation: 'highlighting' });
    w.ollama.choose = (body) => (body['model'] === theirs!.model ? { hold: true } : { response: '[]' });
    const served = await servingBoth(w, second);
    const there = served.at(second);
    await w.ollama.asked(1);
    await eventually("the world's knowledge base to have been claimed at", 15_000, () => (w.claims.length >= 1 ? true : undefined));
    const grants = w.world.issuer.grants.get(WORKER_CLIENT) ?? 0;

    // The world's knowledge base's stream drops: it is working there still.
    const cutAt = performance.now();
    served.proxy.cut();
    expect((await health(served.process)).knowledgeBases[0]).toEqual(expect.objectContaining({ domain: w.domain, state: 'working', did: w.did }));

    // It opens its stream again, claims once it is open, and runs a job it is handed there.
    const reopened = await served.proxy.until('its stream to be opened again', () => served.proxy.requests.filter((r) => r.path === '/bus/subscribe' && r.status === 200)[1], 20_000);
    await served.emitted('job:claim', (e) => e.arrived > reopened.answered!, 1, 15_000);
    const job = markJob(w, 'after-a-drop', { motivation: 'highlighting' });
    await w.announce(job);
    await settled(served, job);

    // Longer than a knowledge base in trouble waits before it is started again: this one was not.
    await sleep(Math.max(0, cutAt + reconnectMs + 1000 - performance.now()));
    expect(logged(served.process.stdout, KB_LOG.trouble)).toEqual([]);
    expect(logged(served.process.stdout, KB_LOG.confirmed).filter(({ domain }) => domain === w.domain)).toHaveLength(1);
    expect(w.world.issuer.grants.get(WORKER_CLIENT) ?? 0).toBe(grants);
    expect(served.signIns().map(({ did }) => did)).toEqual([w.did]);
    expect(served.streams().map(({ by }) => by)).toEqual([w.did, w.did]);
    expect(served.tokens()).toHaveLength(1);
    expect(served.emits('browse:kb-requested')).toHaveLength(1);
    expect(served.emits('principal:profile')).toHaveLength(1);
    expect((await health(served.process)).knowledgeBases[0]).toEqual(expect.objectContaining({ domain: w.domain, state: 'working', did: w.did }));

    // The other kept its one sign-in, its one stream and its job, which it finishes there.
    expect(there.signIns()).toHaveLength(1);
    expect(there.streams().map(({ closed }) => closed)).toEqual([false]);
    expect(heldBy((await health(served.process)).knowledgeBases[1]!)).toBe(held.metadata.id);
    w.ollama.release({ response: '[]' });
    await settled(there, held);
  });

  it.each<[string, GrantFailure]>([
    ['answers its grant 503', 'unavailable'],
    ["ends its grant's connection with no answer", 'unanswered'],
  ])('takes a knowledge base whose issuer %s as trouble: it says so in its log, waits, and signs in there afresh, while the other keeps its stream and the job it holds', async (_what, failure) => {
    const w = world();
    const second = await w.second();
    const reconnectMs = clientTiming('reconnectMs');
    // The second knowledge base's job is held at its model throughout.
    const held = markJob(second, `kept-through-${failure}`, { motivation: 'highlighting' });
    w.ollama.script({ hold: true });
    const grants = w.world.issuer.grants.get(WORKER_CLIENT) ?? 0;
    w.world.issuer.failing.next.push(failure);
    const served = await servingBoth(w, second);
    const there = served.at(second);

    const trouble = await eventually('the trouble in its log', 15_000, () => logged(served.process.stdout, KB_LOG.trouble)[0]);
    expect(trouble).toEqual(expect.objectContaining({ level: 'warn', domain: w.domain, error: expect.any(String), waitMs: reconnectMs }));
    const [failed] = w.world.issuer.failing.met;
    expect(failed?.failure).toBe(failure);
    // While it waits it is starting there, and has asked that gateway nothing; the other is at work on its job.
    await w.ollama.asked(1);
    expect(served.proxy.requests).toEqual([]);
    const waiting = (await health(served.process)).knowledgeBases;
    expect(waiting[0]).toEqual({ domain: w.domain, state: 'starting' });
    expect(waiting[1]).toEqual(expect.objectContaining({ domain: second.domain, state: 'working', did: second.did }));
    expect(heldBy(waiting[1]!)).toBe(held.metadata.id);

    // It is started again once it has waited: a grant of its own, the gateway asked who it is, its stream, the question, its name, and its claims.
    const named = await served.emitted('principal:profile', () => true, 1, 20_000);
    await served.emitted('job:claim', (e) => e.arrived > named.arrived, 1, 15_000);
    const [signIn] = served.proxy.requests.filter((r) => r.path === '/api/users/me');
    expect(signIn!.arrivedMs - failed!.at).toBeGreaterThanOrEqual(reconnectMs);
    expect(w.world.issuer.grants.get(WORKER_CLIENT) ?? 0).toBe(grants + 1);
    expect(served.signIns().map(({ did }) => did)).toEqual([w.did]);
    expect(served.streams().map(({ by }) => by)).toEqual([w.did]);
    expect(served.emits('browse:kb-requested')).toHaveLength(1);
    expect(logged(served.process.stdout, KB_LOG.confirmed).filter(({ domain }) => domain === w.domain)).toEqual([expect.objectContaining({ did: w.did })]);
    expect(logged(served.process.stdout, KB_LOG.trouble)).toHaveLength(1);
    expect((await health(served.process)).knowledgeBases[0]).toEqual(expect.objectContaining({ domain: w.domain, state: 'working', did: w.did }));

    // The other kept its one sign-in, its one stream and its job, which it finishes there.
    expect(there.signIns()).toHaveLength(1);
    expect(there.streams().map(({ closed }) => closed)).toEqual([false]);
    expect(heldBy((await health(served.process)).knowledgeBases[1]!)).toBe(held.metadata.id);
    w.ollama.release({ response: '[]' });
    await settled(there, held);
    // Nothing it wrote carries its key or a token it was granted.
    for (const secret of [w.env.SEMIONT_OIDC_CLIENT_KEY!, ...served.tokens(), ...there.tokens()]) expect(served.process.output.join('\n')).not.toContain(secret);
  });

  it('does not answer GET /health until a knowledge base is confirmed, and then answers it with the one not yet confirmed starting', async () => {
    const w = world();
    const second = await w.second();
    const confirmHere = holdConfirmation(w);
    const confirmThere = holdConfirmation(second);
    const served = await servingBoth(w, second, { spawn: true });
    // Both have been asked which they are, and neither has answered.
    await eventually('both knowledge bases to have been asked which they are', 20_000, () =>
      [w, second].every((kb) => served.at(kb).emits('browse:kb-requested').some((e) => e.status !== undefined)) ? true : undefined,
    );
    expect(await healthAnswersWithin(served, 1500)).toBe(false);

    // The second answers: the worker's health answers, the first still starting.
    confirmThere();
    await served.process.healthy();
    expect((await health(served.process)).knowledgeBases).toEqual([
      { domain: w.domain, state: 'starting' },
      expect.objectContaining({ domain: second.domain, state: 'working', did: second.did }),
    ]);

    // The first answers too.
    confirmHere();
    await eventually('the first to have been confirmed', 15_000, async () => ((await health(served.process)).knowledgeBases[0]!.state === 'working' ? true : undefined));
    expect((await health(served.process)).knowledgeBases[0]).toEqual(expect.objectContaining({ domain: w.domain, state: 'working', did: w.did }));
  });
});
