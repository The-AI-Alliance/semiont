/**
 * Cancellation (JOBS.md § `job:cancel-requested`, § `job:cancel`,
 * § Cancellation): the dispatcher cancels pending jobs, by id or by type;
 * a running job is its worker's to stop, which it confirms with `job:cancel`.
 */
import { expect, it } from 'vitest';
import { everyJob, generation, marks, resourceIdOf, settle, withDispatcher } from '../harness/dispatcher-world';

const cancelled = (answer: { payload: Record<string, unknown> }) => (answer.payload['response'] as { cancelled: number }).cancelled;

withDispatcher('job:cancel-requested', (world) => {
  it('answers 0 for a job it does not know, and for a request naming nothing', async () => {
    const person = await world().person('canceller');
    const unknown = await person.cancelRequest({ jobId: 'job-00000000000000000000000000000000' });
    expect(unknown.channel).toBe('job:cancel-ok');
    expect(cancelled(unknown)).toBe(0);
    expect(cancelled(await person.cancelRequest({}))).toBe(0);
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

  it('cancels every pending mark job, whatever its motivation, and neither yield nor running jobs', async () => {
    const { creator, job: running } = await world().running({ motivation: 'tagging', schemaId: 'irac', categories: ['Issue'] });
    const marking = [
      await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf()),
      await creator.created('mark', { motivation: 'linking', entityTypes: ['Person'] }, resourceIdOf()),
    ];
    const yielding = await creator.created('yield', generation(resourceIdOf()));
    expect(cancelled(await creator.cancelRequest({ jobType: 'mark' }))).toBe(2);
    for (const id of marking) expect((await creator.statusOf(id)).status).toBe('cancelled');
    expect((await creator.statusOf(yielding)).status).toBe('pending');
    expect((await creator.statusOf(running.metadata.id)).status).toBe('running');
  });

  it('cancels every pending yield job, and no mark job', async () => {
    const creator = await world().person('creator');
    const yielding = await creator.created('yield', generation(resourceIdOf()));
    const marking = await creator.created('mark', { motivation: 'commenting' }, resourceIdOf());
    expect(cancelled(await creator.cancelRequest({ jobType: 'yield' }))).toBe(1);
    expect((await creator.statusOf(yielding)).status).toBe('cancelled');
    expect((await creator.statusOf(marking)).status).toBe('pending');
  });

  it('delivers a job created after its type was cancelled: the cancellation took the jobs pending then, and no later one', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('after-the-sweep');
    await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    expect(cancelled(await creator.cancelRequest({ jobType: 'mark' }))).toBe(1);
    const later = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    await world().announced(later);
    expect((await worker.claimed([marks('highlighting')])).metadata.id).toBe(later);
  });

  it('acts on the id when a request names both an id and a type', async () => {
    const creator = await world().person('creator');
    const named = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    const other = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    expect(cancelled(await creator.cancelRequest({ jobId: named, jobType: 'mark' }))).toBe(1);
    expect((await creator.statusOf(named)).status).toBe('cancelled');
    expect((await creator.statusOf(other)).status).toBe('pending');
  });

  it('refuses at the door a request naming a type no job has', async () => {
    const person = await world().person('canceller');
    expect((await person.offered('job:cancel-requested', { jobType: 'annotation' })).status).toBe(400);
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
