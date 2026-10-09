/**
 * Cancellation (JOBS.md § `job:cancel-requested`, § `job:cancel`,
 * § Cancellation): the dispatcher cancels the pending job a request names;
 * a running job is its worker's to stop, which it confirms with `job:cancel`.
 */
import { expect, it } from 'vitest';
import { everyJob, generation, resourceIdOf, settle, withDispatcher } from '../harness/dispatcher-world';

const cancelled = (answer: { payload: Record<string, unknown> }) => (answer.payload['response'] as { cancelled: number }).cancelled;

withDispatcher('job:cancel-requested', (world) => {
  it('answers 0 for a job it does not know', async () => {
    const person = await world().person('canceller');
    const unknown = await person.cancelRequest({ jobId: 'job-00000000000000000000000000000000' });
    expect(unknown.channel).toBe('job:cancel-ok');
    expect(cancelled(unknown)).toBe(0);
  });

  it('cancels a pending job named by id: counted, recorded, and never claimable after', async () => {
    const creator = await world().person('creator');
    const jobId = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    expect(cancelled(await creator.cancelRequest({ jobId }))).toBe(1);
    const status = await creator.statusOf(jobId);
    expect(status.status).toBe('cancelled');
    expect(status.completedAt).toBeDefined();
    expect(status.startedAt).toBeUndefined();
    expect((await (await world().worker('late')).claim(everyJob())).payload['code']).toBe('none-pending');
  });

  it('leaves a running job named by id to its worker, and counts it', async () => {
    const { creator, job } = await world().running({ motivation: 'commenting' });
    expect(cancelled(await creator.cancelRequest({ jobId: job.metadata.id }))).toBe(1);
    await settle();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('running');
  });

  it('answers 0 for a finished job, and leaves it as it was', async () => {
    const { creator, worker, job, ref } = await world().running();
    await worker.complete(ref, { found: 0, persisted: 0 });
    await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    expect(cancelled(await creator.cancelRequest({ jobId: job.metadata.id }))).toBe(0);
    expect((await creator.statusOf(job.metadata.id)).status).toBe('complete');
  });

  it('cancels the job a request names and no other, of its type or of another', async () => {
    const creator = await world().person('creator');
    const named = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    const alike = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    const yielding = await creator.created('yield', generation(resourceIdOf()));
    expect(cancelled(await creator.cancelRequest({ jobId: named }))).toBe(1);
    expect((await creator.statusOf(named)).status).toBe('cancelled');
    expect((await creator.statusOf(alike)).status).toBe('pending');
    expect((await creator.statusOf(yielding)).status).toBe('pending');
  });

  it('refuses at the door a request that names no job: a cancellation selects by id, and no other way', async () => {
    const creator = await world().person('creator');
    const pending = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    expect((await creator.offered('job:cancel-requested', {})).status).toBe(400);
    expect((await creator.offered('job:cancel-requested', { jobType: 'mark' })).status).toBe(400);
    await settle();
    expect((await creator.statusOf(pending)).status).toBe('pending');
  });
});

withDispatcher('job:cancel', (world) => {
  it('cancels the running job its worker stopped', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'linking', entityTypes: ['Person', 'Place'] });
    await worker.cancel(ref);
    const status = await creator.until(job.metadata.id, 'the job to be cancelled', (s) => s.status === 'cancelled');
    expect(status.completedAt).toBeDefined();
  });

  it('leaves a finished job as it was', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'linking', entityTypes: ['Person', 'Place'] });
    await worker.fail(ref, 'broken', { failureClass: 'deterministic' });
    await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed');
    await worker.cancel(ref);
    await settle();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('failed');
  });
});
