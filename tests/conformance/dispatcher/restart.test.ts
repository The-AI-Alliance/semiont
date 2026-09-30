/**
 * Restarts and the broker (JOBS.md § Storage, § `job:queued`, § Periodic
 * work): the queue outlives its dispatcher, a restarted dispatcher announces
 * the pending jobs it receives, and the dispatcher rides out its broker going
 * away and coming back.
 */
import { expect, it } from 'vitest';
import { settle, resourceIdOf, withDispatcher, type BusClient } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';

/** Admit a job once the queue is reachable again; a request made while it reconnects may be refused. */
async function admittedAgain(creator: BusClient, jobType: 'tag-annotation' | 'comment-annotation', params: Record<string, unknown>): Promise<string> {
  return eventually('the queue to admit jobs again', 30_000, async () => {
    const answer = await creator.create(jobType, params, resourceIdOf());
    return answer.ok ? (answer.payload['response'] as { jobId: string }).jobId : undefined;
  });
}

// The acknowledgement window is short so the broker hands a stopped
// dispatcher's deliveries to the next within the case; the tick is long, so an
// announcement inside the case is never the tick's.
withDispatcher('a restarted dispatcher', (world) => {
  it('announces the pending jobs it receives at once, not at its first tick', async () => {
    const creator = await world().person('creator');
    const jobId = await creator.created('comment-annotation', {}, resourceIdOf());
    await world().announced(jobId);

    await world().dispatcher.stop();
    // Longer than the acknowledgement window: the broker delivers the job to
    // the next dispatcher as soon as it connects.
    await settle(2 * world().settings.timing.ackWaitMs);
    await world().restartDispatcher();
    await world().announced(jobId, 2, 5_000);
  });

  it('keeps every job: a pending job is claimable, and a finished one still reads back', async () => {
    const { worker, job, ref } = await world().running('highlight-annotation');
    await worker.complete(ref, { kind: 'highlight-annotation', highlightsFound: 0, highlightsCreated: 0 });
    const creator = await world().person('creator');
    await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    const pendingId = await creator.created('assessment-annotation', {}, resourceIdOf());

    await world().restartDispatcher();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('complete');
    expect((await (await world().worker('after-restart')).claimed(['assessment-annotation'])).metadata.id).toBe(pendingId);
  });

  it('recovers a job whose dispatcher died while it ran, through the dead-worker sweep of the next', async () => {
    const { creator, job } = await world().running('highlight-annotation');
    await world().crashAndRestart((s) => ({ ...s, timing: { ...s.timing, tickMs: 300, staleRunningMs: 1_000 } }));
    await creator.until(job.metadata.id, 'the sweep to re-queue the job', (s) => s.status === 'pending', 15_000);
    const retried = await (await world().worker('recovery')).claimed(['highlight-annotation']);
    expect(retried.metadata).toMatchObject({ id: job.metadata.id, retryCount: 1 });
    await world().restartDispatcher((s) => ({ ...s, timing: { ...s.timing, tickMs: 60_000, staleRunningMs: 30 * 60_000 } }));
  });
}, { timing: { ackWaitMs: 1_000 } });

withDispatcher('the queue\'s broker restarting', (world) => {
  it('is ridden out: once the broker is back, jobs are admitted and claimed again', async () => {
    await world().broker.restart();
    const creator = await world().person('creator');
    const worker = await world().worker('after-broker');
    const jobId = await admittedAgain(creator, 'tag-annotation', { schemaId: 'irac', categories: ['Rule'] });
    expect((await worker.claimed(['tag-annotation'])).metadata.id).toBe(jobId);
  });

  it('is ridden out even when the broker stays away longer than the client\'s own reconnect budget', async () => {
    await world().broker.down();
    await settle(30_000);
    await world().broker.start();
    const creator = await world().person('creator');
    const jobId = await admittedAgain(creator, 'comment-annotation', {});
    expect((await (await world().worker('after-outage')).claimed(['comment-annotation'])).metadata.id).toBe(jobId);
  }, 120_000);
});

withDispatcher('the queue\'s broker returning with other credentials', (world) => {
  it('is not recovered from: jobs are refused rather than accepted and lost', async () => {
    const creator = await world().person('creator');
    await creator.created('highlight-annotation', {}, resourceIdOf());
    await world().broker.restart({ user: 'dispatcher', password: 'rotated' });
    expect((await creator.create('highlight-annotation', {}, resourceIdOf())).channel).toBe('job:create-failed');
    await settle(2_000);
    expect((await creator.create('highlight-annotation', {}, resourceIdOf())).channel).toBe('job:create-failed');

    // A dispatcher started with the broker's credentials serves again.
    await world().broker.restart({ user: 'dispatcher', password: 'original' });
    await world().restartDispatcher();
    await creator.created('highlight-annotation', {}, resourceIdOf());
  });
}, { broker: { user: 'dispatcher', password: 'original' } });
