/**
 * The jobs a worker does not do (WORKER-SERVICE.md § Declines): a resource
 * with nothing to read is declined in the job's completion; a resource that
 * can never be read, and a job the worker cannot run, are failed as
 * deterministic.
 */
import { expect, it } from 'vitest';
import { marks } from '../harness/dispatcher-world';
import { eachWorkerService, type RunningJob, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';
import { identity, markJob, settled } from './support';

/** A job that ends before any work: nothing was asked of the model, nothing committed, and no progress was reported. */
function didNoWork(w: WorkerServiceWorld, served: Served, job: RunningJob): void {
  expect(w.ollama.shows).toEqual([]);
  expect(w.ollama.generations).toEqual([]);
  expect(w.commits).toEqual([]);
  expect(served.progress(job.metadata.id)).toEqual([]);
  expect(served.emits('job:checkpoint')).toEqual([]);
}

eachWorkerService('a job a worker does not do', (world) => {
  it.each([
    ['is empty', ''],
    ['is nothing but white space', ' \n\t\n   \n'],
  ])('completes, declined as empty, a job on a text that %s', async (_what, text) => {
    const w = world();
    const job = markJob(w, 'empty', { motivation: 'highlighting' }, {}, text);
    const served = await w.start();
    const completion = await settled(served, job);

    expect(completion).toEqual({ ...identity(job), result: { declined: true, reason: 'empty' } });
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit browse:resource-requested', `GET /resources/${String(job.params.resourceId)}`, 'emit job:complete', 'emit job:claim']);
    didNoWork(w, served, job);
  });

  it('fails as deterministic a job on a resource whose media type has no text, having read no bytes', async () => {
    const w = world();
    const resourceId = 'res-ws-image';
    w.describe(resourceId, 'image/png');
    const job = w.queued('job-ws-image', 'mark', { resourceId, motivation: 'commenting' });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    // The error names the job, the resource and the media type.
    expect(error).toMatch(/mark \(commenting\)/);
    expect(error).toContain(resourceId);
    expect(error).toContain('image/png');
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit browse:resource-requested', 'emit job:fail', 'emit job:claim']);
    didNoWork(w, served, job);
  });

  it('fails, with no class, a job on a resource the record does not have', async () => {
    const w = world();
    const job = w.queued('job-ws-unknown', 'mark', { resourceId: 'res-ws-unknown', motivation: 'highlighting' });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    expect(failure).toEqual({ ...identity(job), error: 'Resource not found: res-ws-unknown', willRetry: true });
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit browse:resource-requested', 'emit job:fail', 'emit job:claim']);
    didNoWork(w, served, job);
  });

  it('fails as deterministic a job its agent does not serve, having started it and read nothing', async () => {
    const w = world();
    const job = markJob(w, 'not-served', { motivation: 'assessing' });
    // No dispatcher does this: the claim asks for highlighting jobs, and is handed an assessing one.
    w.hooks.handAnyJob = true;
    const served = await w.start({ agents: [w.entry(w.agents[0]!, [marks('highlighting')])] });
    const failure = await settled(served, job, 'job:fail');

    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(error).toMatch(/mark \(assessing\)/);
    expect(served.sequence()).toEqual(['emit job:claim', 'emit job:start', 'emit job:fail', 'emit job:claim']);
    expect(w.descriptorReads).toEqual([]);
    didNoWork(w, served, job);
  });

  it('fails as deterministic a tagging job handed over without the schema it names', async () => {
    const w = world();
    const job = markJob(w, 'no-schema', { motivation: 'tagging', schemaId: 'argument', categories: ['Claim'] });
    const served = await w.start();
    const failure = await settled(served, job, 'job:fail');

    const { error, ...rest } = failure;
    expect(rest).toEqual({ ...identity(job), failureClass: 'deterministic', willRetry: false });
    expect(error).toMatch(/mark \(tagging\)/);
    expect(w.ollama.generations).toEqual([]);
    expect(w.commits).toEqual([]);
  });
});
