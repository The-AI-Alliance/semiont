/**
 * Cancellation (JOBS.md § `job:cancel-requested`, § `job:cancel`,
 * § Cancellation): the dispatcher cancels pending jobs, by id or by category;
 * a running job is its worker's to stop, which it confirms with `job:cancel`.
 */
import { expect, it } from 'vitest';
import { generation, resourceIdOf, settle, withDispatcher } from '../harness/dispatcher-world';

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
    const jobId = await creator.created('highlight-annotation', {}, resourceIdOf());
    expect(cancelled(await creator.cancelRequest({ jobId }))).toBe(1);
    const status = await creator.statusOf(jobId);
    expect(status.status).toBe('cancelled');
    expect(status.completedAt).toBeDefined();
    expect(status.startedAt).toBeUndefined();
    expect((await (await world().worker('late')).claim([])).payload['code']).toBe('none-pending');
  });

  it('leaves a running job named by id to its worker, and counts it', async () => {
    const { creator, job } = await world().running('comment-annotation');
    expect(cancelled(await creator.cancelRequest({ jobId: job.metadata.id }))).toBe(1);
    await settle();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('running');
  });

  it('answers 0 for a finished job, and leaves it as it was', async () => {
    const { creator, worker, job, ref } = await world().running('highlight-annotation');
    await worker.complete(ref, { kind: 'highlight-annotation', highlightsFound: 0, highlightsCreated: 0 });
    await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    expect(cancelled(await creator.cancelRequest({ jobId: job.metadata.id }))).toBe(0);
    expect((await creator.statusOf(job.metadata.id)).status).toBe('complete');
  });

  it('cancels every pending annotation job by category, and neither generation nor running jobs', async () => {
    const { creator, job: running } = await world().running('tag-annotation', { schemaId: 'irac', categories: ['Issue'] });
    const annotations = [
      await creator.created('highlight-annotation', {}, resourceIdOf()),
      await creator.created('reference-annotation', {}, resourceIdOf()),
    ];
    const generating = await creator.created('generation', generation(resourceIdOf()));
    expect(cancelled(await creator.cancelRequest({ jobType: 'annotation' }))).toBe(2);
    for (const id of annotations) expect((await creator.statusOf(id)).status).toBe('cancelled');
    expect((await creator.statusOf(generating)).status).toBe('pending');
    expect((await creator.statusOf(running.metadata.id)).status).toBe('running');
  });

  it('cancels every pending generation job by category, and no annotation job', async () => {
    const creator = await world().person('creator');
    const generating = await creator.created('generation', generation(resourceIdOf()));
    const annotating = await creator.created('comment-annotation', {}, resourceIdOf());
    expect(cancelled(await creator.cancelRequest({ jobType: 'generation' }))).toBe(1);
    expect((await creator.statusOf(generating)).status).toBe('cancelled');
    expect((await creator.statusOf(annotating)).status).toBe('pending');
  });

  it('acts on the id when a request names both an id and a category', async () => {
    const creator = await world().person('creator');
    const named = await creator.created('highlight-annotation', {}, resourceIdOf());
    const other = await creator.created('highlight-annotation', {}, resourceIdOf());
    expect(cancelled(await creator.cancelRequest({ jobId: named, jobType: 'annotation' }))).toBe(1);
    expect((await creator.statusOf(named)).status).toBe('cancelled');
    expect((await creator.statusOf(other)).status).toBe('pending');
  });
});

withDispatcher('job:cancel', (world) => {
  it('cancels the running job its worker stopped', async () => {
    const { creator, worker, job, ref } = await world().running('reference-annotation');
    await worker.cancel(ref);
    const status = await creator.until(job.metadata.id, 'the job to be cancelled', (s) => s.status === 'cancelled');
    expect(status.completedAt).toBeDefined();
  });

  it('leaves a finished job as it was', async () => {
    const { creator, worker, job, ref } = await world().running('reference-annotation');
    await worker.fail(ref, 'broken', { failureClass: 'deterministic' });
    await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed');
    await worker.cancel(ref);
    await settle();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('failed');
  });
});
