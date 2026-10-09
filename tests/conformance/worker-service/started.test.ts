/**
 * A worker that has started (WORKER-SERVICE.md § Agents, § Health): the agents
 * it signs in as, the stream each opens, the filters each claims with, the
 * agent a job is run by, and what `GET /health` answers.
 */
import { expect, it } from 'vitest';
import { marks, YIELDS } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { WORKER_ROLE } from '../harness/roles';
import { operationFor } from '../harness/spec';
import { eachWorkerService, WORKER_CLIENT, type JobFilter, type Served, type WorkerAgent, type WorkerServiceWorld } from '../harness/worker-service-world';
import { expectGenerations, FORMATS, generation, identity, markJob, settled, TEXT, textAnnotation, withoutCreated } from './support';

/** The reply channels of the operations a worker awaits, and the two broadcasts it reads. */
const replies = (operation: string): string[] => {
  const { result, failure } = operationFor(operation);
  return [result, failure];
};
const namedByEveryAgent = (): string[] =>
  [
    ...['job:claim', 'mark:commit', 'browse:annotation-requested', 'browse:resource-requested', 'browse:anchored-text-requested'].flatMap(replies),
    'job:queued',
    'job:cancel-requested',
  ].sort();

/** What an idle agent that has done nothing says of itself. */
const IDLE = { lastQueuedEventAt: null, lastClaimAt: null, lastFinishedAt: null, lastActivityAt: null, activeJob: null, jobsCompleted: 0 };

const instant = (value: unknown): boolean => typeof value === 'string' && new Date(value).toISOString() === value;

/** A worker of two agents: the first serves two motivations of `mark` jobs, the second `yield` jobs. */
async function twoAgents(w: WorkerServiceWorld): Promise<{ served: Served; first: WorkerAgent; second: WorkerAgent; accepts: [JobFilter[], JobFilter[]] }> {
  const [first, second] = w.agents;
  const accepts: [JobFilter[], JobFilter[]] = [[marks('highlighting'), marks('commenting')], [YIELDS]];
  const served = await w.start({ agents: [w.entry(first!, accepts[0]), w.entry(second!, accepts[1])] });
  // Each agent claims once its stream is open, and is told nothing is pending.
  await eventually('both agents to have claimed', 15_000, () => (w.claims.length >= 2 ? true : undefined));
  return { served, first: first!, second: second!, accepts };
}

const byModel = <T extends { model: unknown }>(entries: T[]): T[] => [...entries].sort((a, b) => (String(a.model) < String(b.model) ? -1 : 1));
const byDid = <T extends { by: unknown }>(entries: T[]): T[] => [...entries].sort((a, b) => (String(a.by) < String(b.by) ? -1 : 1));

eachWorkerService('a started worker', (world) => {
  it('signs in once as each agent of its document, with its own service account, and is named by the gateway', async () => {
    const w = world();
    const grants = w.world.issuer.grants.get(WORKER_CLIENT) ?? 0;
    const { served, first, second } = await twoAgents(w);
    expect(byModel(served.signIns().map(({ provider, model, did }) => ({ provider, model, did })))).toEqual(
      byModel([
        { provider: first.provider, model: first.model, did: first.did },
        { provider: second.provider, model: second.model, did: second.did },
      ]),
    );
    expect(w.world.issuer.grants.get(WORKER_CLIENT) ?? 0).toBeGreaterThan(grants);
  });

  it('opens one stream for each agent, naming what a worker reads, and on its first agent\'s the request that agent answers', async () => {
    const w = world();
    const { served, first, second } = await twoAgents(w);
    const streams = byDid(served.streams().map(({ by, body }) => ({ by, global: [...(body['global'] as string[])].sort(), scoped: body['scoped'] })));
    expect(streams).toEqual(
      byDid([
        { by: first.did, global: [...namedByEveryAgent(), 'job:limits-requested'].sort(), scoped: [] },
        { by: second.did, global: namedByEveryAgent(), scoped: [] },
      ]),
    );
  });

  it('claims for each agent with that agent\'s filters and no others, as a worker', async () => {
    const w = world();
    const { served, first, second, accepts } = await twoAgents(w);
    expect(byDid(w.claims.map(({ by, accepts: filters, answered }) => ({ by, accepts: filters, answered })))).toEqual(
      byDid([
        { by: first.did, accepts: accepts[0], answered: undefined },
        { by: second.did, accepts: accepts[1], answered: undefined },
      ]),
    );
    for (const claim of w.claims) expect(claim.roles).toContain(WORKER_ROLE);
    // On the wire a claim is its filters and nothing else, said to no scope.
    expect(byDid(served.emits('job:claim').map(({ by, payload, scope }) => ({ by, payload, scope })))).toEqual(
      byDid([
        { by: first.did, payload: { accepts: accepts[0] }, scope: undefined },
        { by: second.did, payload: { accepts: accepts[1] }, scope: undefined },
      ]),
    );
  });

  it('answers GET /health, without a token, with its agents and what each can say of itself', async () => {
    const w = world();
    const { served, first, second, accepts } = await twoAgents(w);
    const health = await served.process.http('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toMatch(/^application\/json/);
    expect(health.json).toEqual({
      status: 'ok',
      agents: 2,
      workers: [
        { provider: first.provider, model: first.model, did: first.did, serves: accepts[0], ...IDLE },
        { provider: second.provider, model: second.model, did: second.did, serves: accepts[1], ...IDLE },
      ],
    });
  });

  it('answers 404, with no body, anywhere else', async () => {
    const w = world();
    const { served } = await twoAgents(w);
    for (const path of ['/', '/api/health', '/healthz', '/health/live']) {
      const reply = await served.process.http('GET', path);
      expect(reply.status, path).toBe(404);
      expect(reply.text, path).toBe('');
    }
  });

  it('matches /health without its query string, and answers it by GET alone', async () => {
    const w = world();
    const { served } = await twoAgents(w);
    const plain = await served.process.http('GET', '/health');
    for (const path of ['/health?probe=1', '/health?']) {
      const reply = await served.process.http('GET', path);
      expect(reply.status, path).toBe(200);
      expect(reply.json, path).toEqual(plain.json);
    }
    // A query string is no part of another path either.
    expect((await served.process.http('GET', '/healthz?probe=1')).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const reply = await served.process.http(method, '/health');
      expect(reply.status, method).toBe(404);
      expect(reply.text, method).toBe('');
    }
  });

  it('says in /health when an agent heard an announcement, the job it holds, and the jobs it has completed', async () => {
    const w = world();
    const agent = w.agents[0]!;
    const served = await w.start();
    await eventually('the agent to have claimed', 15_000, () => (w.claims.length >= 1 ? true : undefined));
    const vitals = async () => ((await served.process.http('GET', '/health')).json as { workers: Array<Record<string, unknown>> }).workers[0]!;
    expect(await vitals()).toEqual({ provider: agent.provider, model: agent.model, did: agent.did, serves: served.process.settings.agents[0]!.accepts, ...IDLE });

    // A job is announced: the agent claims it, and holds it while its model is silent.
    const job = markJob(w, 'held', { motivation: 'highlighting' });
    w.ollama.script({ hold: true });
    await w.announce(job);
    await w.ollama.asked(1);
    const holding = await vitals();
    expect(holding['activeJob']).toEqual({ jobId: job.metadata.id, type: 'mark', since: expect.any(String) });
    expect(instant((holding['activeJob'] as { since: unknown }).since)).toBe(true);
    for (const stamp of ['lastQueuedEventAt', 'lastClaimAt', 'lastActivityAt']) expect(instant(holding[stamp]), stamp).toBe(true);
    expect(holding['lastFinishedAt']).toBeNull();
    expect(holding['jobsCompleted']).toBe(0);

    w.ollama.release({ response: '[]' });
    await settled(served, job);
    const after = await vitals();
    expect(after['activeJob']).toBeNull();
    expect(after['jobsCompleted']).toBe(1);
    expect(instant(after['lastFinishedAt'])).toBe(true);
  });

  it('runs each job as the agent that claimed it: on that agent\'s model, and attributed to it', async () => {
    const w = world();
    const [first, second] = w.agents;
    const highlights = markJob(w, 'by-first', { motivation: 'highlighting' });
    const comments = markJob(w, 'by-second', { motivation: 'commenting' });
    // The two agents work at once, so the provider answers by which model asked.
    w.ollama.choose = (body) =>
      body['model'] === first!.model
        ? { response: JSON.stringify([{ exact: 'the first program' }]) }
        : { response: JSON.stringify([{ exact: 'Charles Babbage', comment: 'He designed the engine.' }]) };
    const served = await w.start({ agents: [w.entry(first!, [marks('highlighting')]), w.entry(second!, [marks('commenting')])] });
    await settled(served, highlights);
    await settled(served, comments);

    // Each claim was answered with the job its filters take.
    expect(byDid(w.claims.filter((c) => c.answered !== undefined).map(({ by, answered }) => ({ by, answered })))).toEqual(
      byDid([
        { by: first!.did, answered: highlights.metadata.id },
        { by: second!.did, answered: comments.metadata.id },
      ]),
    );
    // Each agent asked its own model, once for its limits and once for the job.
    expect(byModel(w.ollama.shows as Array<{ model: unknown }>)).toEqual(byModel([{ model: first!.model }, { model: second!.model }]));
    const asked = (model: string) => w.ollama.generations.filter((g) => g.body['model'] === model);
    expectGenerations(asked(first!.model), [generation(first!.model, 'highlighting', { num_predict: 5284, num_ctx: 5785, temperature: 0 }, FORMATS.highlighting)]);
    expect(asked(second!.model).map((g) => g.body['model'])).toEqual([second!.model]);

    // Everything said of a job was said by its agent, and what it made names that agent as its generator.
    for (const [job, agent] of [[highlights, first!], [comments, second!]] as const) {
      const said = served.emits().filter((e) => e.payload['jobId'] === job.metadata.id);
      expect(said.length).toBeGreaterThan(0);
      expect([...new Set(said.map((e) => e.by))]).toEqual([agent.did]);
      expect(served.payloads('job:start').filter((p) => p['jobId'] === job.metadata.id)).toEqual([identity(job)]);
      const commits = w.commits.filter((c) => c.jobId === job.metadata.id);
      expect(commits.map((c) => c.by)).toEqual([agent.did]);
      expect(withoutCreated(commits[0]!.annotations).map((a) => a['generator'])).toEqual([w.generator(agent)]);
    }
    expect(withoutCreated(w.commits.find((c) => c.jobId === highlights.metadata.id)!.annotations)).toEqual([
      textAnnotation(w.generator(first!), String(highlights.params.resourceId), 'highlighting', '6Sa0pcDOQxgkzQu8ZFUzD', {
        start: 23,
        end: 40,
        exact: 'the first program',
        prefix: 'Ada Lovelace published ',
        suffix: ' in 1843 — a method for computing Bernoulli numbers on the Analytical',
      }),
    ]);
    expect(TEXT.slice(23, 40)).toBe('the first program');
  });
});
