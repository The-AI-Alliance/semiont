/**
 * Stopping (WORKER-SERVICE.md § Stopping): what a worker does on SIGTERM,
 * idle and while it holds a job, and the one refusal of a claim it exits on.
 */
import { expect, it } from 'vitest';
import { eventually } from '../harness/net';
import { eachWorkerService } from '../harness/worker-service-world';
import { identity, markJob } from './support';

eachWorkerService('a worker that stops', (world) => {
  it('exits 0 on SIGTERM when it holds nothing, having said nothing more on the bus, and answers /health no more', async () => {
    const w = world();
    const served = await w.start();
    await eventually('the worker to have claimed', 15_000, () => (w.claims.length >= 1 ? true : undefined));
    const said = served.emits().length;

    expect(await served.process.stop()).toBe(0);
    expect(served.emits().slice(said)).toEqual([]);
    await expect(served.process.http('GET', '/health')).rejects.toThrow();
  });

  it('fails the job it holds before it exits 0 on SIGTERM, saying that the worker stopped and whether the job will be retried', async () => {
    const w = world();
    const job = markJob(w, 'stopped', { motivation: 'highlighting' });
    // The model never answers: the worker holds the job when it is told to stop.
    w.ollama.script({ hold: true });
    const served = await w.start();
    await w.ollama.asked(1);

    expect(await served.process.stop()).toBe(0);
    const failures = served.emits('job:fail');
    expect(failures.map((f) => f.status)).toEqual([202]);
    const { error, ...rest } = failures[0]!.payload;
    // No class is stated: the job's retry budget decides.
    expect(rest).toEqual({ ...identity(job), willRetry: true });
    expect(error).toMatch(/stopped/);
    expect(served.emits('job:complete')).toEqual([]);
    // Having failed the job, it claims no other.
    expect(served.emits('job:claim')).toHaveLength(1);
  });

  it('exits 1 when a claim is refused as unauthorized: its account cannot claim, and will not be able to later', async () => {
    const w = world();
    const served = await w.start();
    await eventually('the worker to have claimed', 15_000, () => (w.claims.length >= 1 ? true : undefined));

    // The next claim is refused as the dispatcher refuses one from an account that is no worker's.
    w.hooks.claim = () => ({ code: 'unauthorized', message: 'This agent is not a worker' });
    const job = markJob(w, 'unauthorized', { motivation: 'highlighting' });
    await w.announce(job);
    expect(await served.process.exited).toBe(1);
    expect(served.emits('job:start')).toEqual([]);
  });

  it('goes on claiming after a claim refused for any other reason', async () => {
    const w = world();
    const served = await w.start();
    await eventually('the worker to have claimed', 15_000, () => (w.claims.length >= 1 ? true : undefined));

    w.hooks.claim = () => ({ code: 'peer-unavailable', message: 'The queue cannot be reached' });
    const job = markJob(w, 'refused-claim', { motivation: 'highlighting' });
    await w.announce(job);
    await eventually('the refused claim', 15_000, () => (w.claims.length >= 2 ? true : undefined));

    // It is still up, and the next announcement is claimed and run.
    expect((await served.process.http('GET', '/health')).status).toBe(200);
    w.hooks = {};
    w.ollama.script({ response: '[]' });
    await w.announce(job);
    await served.emitted('job:complete', (e) => e.payload['jobId'] === job.metadata.id);
  });
});
