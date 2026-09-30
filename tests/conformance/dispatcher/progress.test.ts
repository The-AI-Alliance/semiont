/**
 * Progress and checkpoints (JOBS.md § `job:report-progress`,
 * § `job:checkpoint`, § Checkpoints). The job's status shows its progress;
 * its checkpoint is not exposed, so a checkpoint is read the way a worker
 * reads it — off the claim of the attempt that follows a failure.
 */
import { expect, it } from 'vitest';
import { resourceIdOf, settle, withDispatcher, type BusClient, type DispatcherWorld, type JobRef, type RunningJob } from '../harness/dispatcher-world';

const cursor = (next: number, size = 10) => ({ next, size, found: next * 2, emitted: next });

/** End the attempt and claim the next: the claim carries the checkpoint as the record holds it. */
async function retried(world: DispatcherWorld, worker: BusClient, job: RunningJob, ref: JobRef): Promise<RunningJob['metadata']> {
  await settle();
  await worker.fail(ref, 'interrupted');
  const creator = await world.person('creator');
  await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
  return (await worker.claimed([job.metadata.type])).metadata;
}

withDispatcher('job:report-progress', (world) => {
  it('records the progress a worker reports, whole', async () => {
    const { creator, worker, job, ref } = await world().running('tag-annotation', { schemaId: 'irac', categories: ['Issue'] });
    const progress = { percentage: 40, message: { code: 'analyzing-tags' }, current: { kind: 'category', value: 'Issue' }, processed: 1, total: 2 };
    await worker.reportProgress(ref, 40, progress);
    expect((await creator.until(job.metadata.id, 'the progress to show', (s) => (s.progress as { percentage?: number }).percentage === 40)).progress).toEqual(progress);
  });

  it('records a bare percentage when the report carries no progress', async () => {
    const { creator, worker, job, ref } = await world().running('highlight-annotation');
    await worker.reportProgress(ref, 70);
    expect((await creator.until(job.metadata.id, 'the progress to show', (s) => Object.keys(s.progress as object).length > 0)).progress).toEqual({ percentage: 70 });
  });

  it('ignores progress for a job that is not running: its claim starts with none', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('premature');
    const resourceId = resourceIdOf();
    const jobId = await creator.created('comment-annotation', {}, resourceId);
    await worker.reportProgress({ jobId, jobType: 'comment-annotation', resourceId }, 90);
    await settle();
    expect((await creator.statusOf(jobId)).progress).toBeUndefined();
    expect((await worker.claimed(['comment-annotation'])).progress).toEqual({});
  });
});

withDispatcher('job:checkpoint', (world) => {
  it('records finished units, and a retry resumes with them', async () => {
    const { worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, ['Person']);
    expect((await retried(world(), worker, job, ref)).completedUnits).toEqual(['Person']);
  });

  it('unions successive checkpoints', async () => {
    const { worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, ['Person']);
    await settle();
    await worker.checkpoint(job.metadata.id, ['Place', 'Person']);
    expect([...(await retried(world(), worker, job, ref)).completedUnits!].sort()).toEqual(['Person', 'Place']);
  });

  it('records a cursor for an unfinished unit without finishing it', async () => {
    const { worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(2) });
    const metadata = await retried(world(), worker, job, ref);
    expect(metadata.unitCursors).toEqual({ Person: cursor(2) });
    expect(metadata.completedUnits ?? []).toEqual([]);
  });

  it('advances a cursor, and never moves it back: a late, older cursor leaves the newer one whole', async () => {
    const { worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(2) });
    await settle();
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(5, 12) });
    await settle();
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(3, 99) });
    expect((await retried(world(), worker, job, ref)).unitCursors).toEqual({ Person: cursor(5, 12) });
  });

  it('keeps a cursor per unit', async () => {
    const { worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(2) });
    await settle();
    await worker.checkpoint(job.metadata.id, [], { Place: cursor(7) });
    expect((await retried(world(), worker, job, ref)).unitCursors).toEqual({ Person: cursor(2), Place: cursor(7) });
  });

  it('drops the cursor of a unit that finishes, and ignores a later cursor for it', async () => {
    const { worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(2), Place: cursor(4) });
    await settle();
    await worker.checkpoint(job.metadata.id, ['Person']);
    await settle();
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(9) });
    const metadata = await retried(world(), worker, job, ref);
    expect(metadata.completedUnits).toEqual(['Person']);
    expect(metadata.unitCursors).toEqual({ Place: cursor(4) });
  });

  it('leaves no cursors at all once none remains', async () => {
    const { worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, [], { Person: cursor(2) });
    await settle();
    await worker.checkpoint(job.metadata.id, ['Person']);
    const metadata = await retried(world(), worker, job, ref);
    expect(metadata.completedUnits).toEqual(['Person']);
    expect('unitCursors' in metadata).toBe(false);
  });

  it('has no effect on a job that is not running', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('premature');
    const jobId = await creator.created('reference-annotation', {}, resourceIdOf());
    await worker.checkpoint(jobId, ['Person'], { Place: cursor(1) });
    await settle();
    const metadata = (await worker.claimed(['reference-annotation'])).metadata;
    expect('completedUnits' in metadata).toBe(false);
    expect('unitCursors' in metadata).toBe(false);
  });
});
