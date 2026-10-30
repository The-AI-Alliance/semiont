/**
 * A worker that has started (WORKER-SERVICE.md § The agent, § Health): the
 * one sign-in it makes as its account, the one stream it opens, what it says
 * it is called, the filters each engine claims with, the engine a job is run
 * on and who it is attributed to, and what `GET /health` answers.
 */
import { expect, it } from 'vitest';
import { marks, YIELDS } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { operationFor } from '../harness/spec';
import { eachWorkerService, WORKER_CLIENT, WORKER_ROLES, type Engine, type JobFilter, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';
import { expectGenerations, FORMATS, generation, identity, markJob, settled, TEXT, textAnnotation, withoutCreated } from './support';

/** The reply channels of the operations a worker awaits, and the two broadcasts it reads. */
const replies = (operation: string): string[] => {
  const { result, failure } = operationFor(operation);
  return [result, failure];
};
const namedByAWorker = (): string[] =>
  [
    ...['job:claim', 'mark:commit', 'browse:annotation-requested', 'browse:resource-requested'].flatMap(replies),
    'job:queued',
    'job:cancel-requested',
  ].sort();

/** What an idle engine that has done nothing says of itself. */
const IDLE = { lastQueuedEventAt: null, lastClaimAt: null, lastFinishedAt: null, lastActivityAt: null, activeJob: null, jobsCompleted: 0 };

const instant = (value: unknown): boolean => typeof value === 'string' && new Date(value).toISOString() === value;

/** A worker of two engines: the first used for two motivations of `mark` jobs, the second for `yield` jobs. */
async function twoEngines(w: WorkerServiceWorld): Promise<{ served: Served; first: Engine; second: Engine; jobs: [JobFilter[], JobFilter[]] }> {
  const [first, second] = w.engines;
  const jobs: [JobFilter[], JobFilter[]] = [[marks('highlighting'), marks('commenting')], [YIELDS]];
  const served = await w.start({ engines: [w.entry(first!, jobs[0]), w.entry(second!, jobs[1])] });
  // Each engine claims once the stream is open, and is told nothing is pending.
  await eventually('both engines to have claimed', 15_000, () => (w.claims.length >= 2 ? true : undefined));
  return { served, first: first!, second: second!, jobs };
}

const byModel = <T extends { model: unknown }>(entries: T[]): T[] => [...entries].sort((a, b) => (String(a.model) < String(b.model) ? -1 : 1));
/** Claims in a fixed order of their own: by the filters they carry. */
const byFilters = <T extends { accepts: unknown }>(entries: T[]): T[] => [...entries].sort((a, b) => (JSON.stringify(a.accepts) < JSON.stringify(b.accepts) ? -1 : 1));

eachWorkerService('a started worker', (world) => {
  it('signs in once, as its account, and is named by the gateway as that account', async () => {
    const w = world();
    const grants = w.world.issuer.grants.get(WORKER_CLIENT) ?? 0;
    const { served } = await twoEngines(w);
    // One grant of its account, and one question of the gateway, whatever the engines it runs.
    expect(served.signIns().map(({ did }) => did)).toEqual([w.did]);
    expect(w.world.issuer.grants.get(WORKER_CLIENT) ?? 0).toBe(grants + 1);
  });

  it('opens one stream, naming what a worker reads and the request it answers', async () => {
    const w = world();
    const { served } = await twoEngines(w);
    expect(served.streams().map(({ by, body }) => ({ by, global: [...(body['global'] as string[])].sort(), scoped: body['scoped'] }))).toEqual([
      { by: w.did, global: [...namedByAWorker(), 'job:limits-requested'].sort(), scoped: [] },
    ]);
  });

  it('claims for each engine with its own filters and no others, as a worker, all as the one agent', async () => {
    const w = world();
    const { served, jobs } = await twoEngines(w);
    expect(byFilters(w.claims.map(({ by, accepts: filters, answered }) => ({ by, accepts: filters, answered })))).toEqual(
      byFilters([
        { by: w.did, accepts: jobs[0], answered: undefined },
        { by: w.did, accepts: jobs[1], answered: undefined },
      ]),
    );
    // Each claim carries the roles of the agent's account, as its token carries them.
    for (const claim of w.claims) expect(claim.roles).toEqual([...WORKER_ROLES]);
    // On the wire a claim is its filters and nothing else, said to no scope.
    expect(byFilters(served.emits('job:claim').map(({ by, payload, scope }) => ({ by, accepts: payload['accepts'], payload, scope })))).toEqual(
      byFilters([
        { by: w.did, accepts: jobs[0], payload: { accepts: jobs[0] }, scope: undefined },
        { by: w.did, accepts: jobs[1], payload: { accepts: jobs[1] }, scope: undefined },
      ]),
    );
  });

  it('says it is called by its client id, once, as itself, when it opens its stream and before it claims', async () => {
    const w = world();
    const { served } = await twoEngines(w);
    expect(served.emits('principal:profile').map(({ by, payload, scope, status }) => ({ by, payload, scope, status }))).toEqual([
      { by: w.did, payload: { name: WORKER_CLIENT }, scope: undefined, status: 202 },
    ]);
    const asked = served.sequence();
    expect(asked.indexOf('emit principal:profile')).toBeLessThan(asked.indexOf('emit job:claim'));
  });

  it('answers GET /health, without a token, with who it is, its engines and what each can say of itself', async () => {
    const w = world();
    const { served, first, second, jobs } = await twoEngines(w);
    const health = await served.process.http('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('content-type')).toMatch(/^application\/json/);
    expect(health.json).toEqual({
      status: 'ok',
      did: w.did,
      engines: [
        { provider: first.provider, model: first.model, jobs: jobs[0], ...IDLE },
        { provider: second.provider, model: second.model, jobs: jobs[1], ...IDLE },
      ],
    });
  });

  it('answers 404, with no body, anywhere else', async () => {
    const w = world();
    const { served } = await twoEngines(w);
    for (const path of ['/', '/api/health', '/healthz', '/health/live']) {
      const reply = await served.process.http('GET', path);
      expect(reply.status, path).toBe(404);
      expect(reply.text, path).toBe('');
    }
  });

  it('matches /health without its query string, and answers it by GET alone', async () => {
    const w = world();
    const { served } = await twoEngines(w);
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

  it('says in /health when an engine heard an announcement, the job it holds, and the jobs it has completed', async () => {
    const w = world();
    const engine = w.engines[0]!;
    const served = await w.start();
    await eventually('the engine to have claimed', 15_000, () => (w.claims.length >= 1 ? true : undefined));
    const vitals = async () => ((await served.process.http('GET', '/health')).json as { engines: Array<Record<string, unknown>> }).engines[0]!;
    expect(await vitals()).toEqual({ provider: engine.provider, model: engine.model, jobs: served.process.settings.engines[0]!.jobs, ...IDLE });

    // A job is announced: the engine claims it, and holds it while its model is silent.
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

  it('runs each job on the engine whose claim took it, and attributes what it makes to the agent and that engine', async () => {
    const w = world();
    const [first, second] = w.engines;
    const highlights = markJob(w, 'by-first', { motivation: 'highlighting' });
    const comments = markJob(w, 'by-second', { motivation: 'commenting' });
    // The two engines work at once, so the provider answers by which model asked.
    w.ollama.choose = (body) =>
      body['model'] === first!.model
        ? { response: JSON.stringify([{ exact: 'the first program' }]) }
        : { response: JSON.stringify([{ exact: 'Charles Babbage', comment: 'He designed the engine.' }]) };
    const served = await w.start({ engines: [w.entry(first!, [marks('highlighting')]), w.entry(second!, [marks('commenting')])] });
    await settled(served, highlights);
    await settled(served, comments);

    // Each claim was answered with the job its filters take, and every claim was the one agent's.
    expect(byFilters(w.claims.filter((c) => c.answered !== undefined).map(({ by, accepts, answered }) => ({ by, accepts, answered })))).toEqual(
      byFilters([
        { by: w.did, accepts: [marks('highlighting')], answered: highlights.metadata.id },
        { by: w.did, accepts: [marks('commenting')], answered: comments.metadata.id },
      ]),
    );
    // Each engine asked its own model, once for its limits and once for the job.
    expect(byModel(w.ollama.shows as Array<{ model: unknown }>)).toEqual(byModel([{ model: first!.model }, { model: second!.model }]));
    const asked = (model: string) => w.ollama.generations.filter((g) => g.body['model'] === model);
    expectGenerations(asked(first!.model), [generation(first!.model, 'highlighting', { num_predict: 5284, num_ctx: 5785, temperature: 0 }, FORMATS.highlighting)]);
    expect(asked(second!.model).map((g) => g.body['model'])).toEqual([second!.model]);

    // Everything said of a job was said by the agent, and what it made names the agent and the engine that made it.
    for (const [job, engine] of [[highlights, first!], [comments, second!]] as const) {
      const said = served.emits().filter((e) => e.payload['jobId'] === job.metadata.id);
      expect(said.length).toBeGreaterThan(0);
      expect([...new Set(said.map((e) => e.by))]).toEqual([w.did]);
      expect(served.payloads('job:start').filter((p) => p['jobId'] === job.metadata.id)).toEqual([identity(job)]);
      const commits = w.commits.filter((c) => c.jobId === job.metadata.id);
      expect(commits.map((c) => c.by)).toEqual([w.did]);
      expect(withoutCreated(commits[0]!.annotations).map((a) => a['generator'])).toEqual([w.generator(engine)]);
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
