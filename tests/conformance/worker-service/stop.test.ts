/**
 * Stopping (WORKER-SERVICE.md § Stopping): what a worker does on SIGTERM,
 * idle and while it holds a job; the one refusal of a claim that refuses the
 * knowledge base it was made at; and the exit once every knowledge base it
 * serves has refused it, one having been confirmed first (§ Knowledge bases).
 */
import { expect, it } from 'vitest';
import { everyJob } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { eachWorkerService } from '../harness/worker-service-world';
import { health, identity, KB_LOG, logged, markJob, settled } from './support';

/** How the dispatcher refuses a claim from an account that is no worker's. */
const UNAUTHORIZED = () => ({ code: 'unauthorized', message: 'This agent is not a worker' });

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

  it('refuses its one knowledge base when a claim there is refused as unauthorized, and exits 1, saying so in its log and nothing on stderr', async () => {
    const w = world();
    const served = await w.start();
    await eventually('the worker to have claimed', 15_000, () => (w.claims.length >= 1 ? true : undefined));

    // The next claim is refused as the dispatcher refuses one from an account that is no worker's: its grant is gone, and will not come back.
    w.hooks.claim = UNAUTHORIZED;
    const job = markJob(w, 'unauthorized', { motivation: 'highlighting' });
    await w.announce(job);
    expect(await served.process.exited).toBe(1);
    await served.process.stop();
    expect(served.emits('job:start')).toEqual([]);
    expect(logged(served.process.stdout, KB_LOG.refused)).toEqual([expect.objectContaining({ level: 'error', domain: w.domain, reason: expect.any(String) })]);
    // The knowledge base was confirmed first, so the service had started: everything it wrote is its log.
    expect(served.process.stderr).toEqual([]);
  });

  it('refuses only the knowledge base a claim was refused at as unauthorized, goes on at the other, and exits 1 once that one refuses it too', async () => {
    const w = world();
    const second = await w.second();
    const served = await w.start({ serving: [{ kb: second, engines: [w.entry(w.engines[0]!, everyJob())] }] });
    await eventually('the worker to have claimed at both', 15_000, () => (w.claims.length >= 1 && second.claims.length >= 1 ? true : undefined));

    second.hooks.claim = UNAUTHORIZED;
    await second.announce(markJob(second, 'unauthorized-there', { motivation: 'highlighting' }));
    const there = served.at(second);
    await there.proxy.until('its stream there to end', () => (there.streams().every((s) => s.closed) ? true : undefined), 15_000);
    await eventually('the refusal in its log', 15_000, () => (logged(served.process.stdout, KB_LOG.refused).length > 0 ? true : undefined));
    expect(logged(served.process.stdout, KB_LOG.refused)).toEqual([expect.objectContaining({ level: 'error', domain: second.domain, reason: expect.any(String) })]);
    expect((await health(served.process)).knowledgeBases.map(({ domain, state, did }) => ({ domain, state, did }))).toEqual([
      { domain: w.domain, state: 'working', did: w.did },
      { domain: second.domain, state: 'refused', did: undefined },
    ]);

    // The other knowledge base's work goes on, and the refused one is claimed at no more.
    const claimedThere = second.claims.length;
    const job = markJob(w, 'still-here', { motivation: 'highlighting' });
    w.ollama.script({ response: '[]' });
    await w.announce(job);
    await settled(served, job);
    expect(second.claims).toHaveLength(claimedThere);

    // The last knowledge base not refused refuses it: it exits.
    w.hooks.claim = UNAUTHORIZED;
    await w.announce(markJob(w, 'unauthorized-here', { motivation: 'highlighting' }));
    expect(await served.process.exited).toBe(1);
    await served.process.stop();
    expect(logged(served.process.stdout, KB_LOG.refused).map(({ domain }) => domain)).toEqual([second.domain, w.domain]);
    expect(served.process.stderr).toEqual([]);
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
    expect((await health(served.process)).knowledgeBases[0]!.state).toBe('working');
    w.hooks = {};
    w.ollama.script({ response: '[]' });
    await w.announce(job);
    await served.emitted('job:complete', (e) => e.payload['jobId'] === job.metadata.id);
  });
});
