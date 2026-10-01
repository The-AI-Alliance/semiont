/**
 * Concluding an attempt (JOBS.md § `job:complete`, § `job:fail`, § Retries):
 * completion, and a failure retried or final by the retry predicate, with the
 * checkpoint it carries merged either way. A conclusion names a job that must
 * be running; for anything else it has no effect.
 */
import { expect, it } from 'vitest';
import { resourceIdOf, settle, withDispatcher } from '../harness/dispatcher-world';

const HIGHLIGHTS = { kind: 'highlight-annotation', highlightsFound: 4, highlightsCreated: 3 };

withDispatcher('job:complete', (world) => {
  it('completes a running job with its result, keeping the time it started', async () => {
    const { creator, worker, job, ref } = await world().running('highlight-annotation');
    await worker.complete(ref, HIGHLIGHTS);
    const status = await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    expect(status).toMatchObject({ startedAt: job.startedAt, result: HIGHLIGHTS });
    expect(Date.parse(status.completedAt!)).toBeGreaterThanOrEqual(Date.parse(job.startedAt));
    expect(status.progress).toBeUndefined();
  });

  it('records an empty result when the completion carries none', async () => {
    const { creator, worker, job, ref } = await world().running('comment-annotation');
    await worker.complete(ref);
    const status = await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    expect(status.result).toEqual({});
  });

  it('has no effect on a job that is not running, and the dispatcher keeps serving', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('premature');
    const resourceId = resourceIdOf();
    const jobId = await creator.created('highlight-annotation', {}, resourceId);
    await worker.complete({ jobId, jobType: 'highlight-annotation', resourceId }, HIGHLIGHTS);
    await worker.complete({ jobId: 'job-00000000000000000000000000000000', jobType: 'highlight-annotation', resourceId }, HIGHLIGHTS);
    await settle();
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await worker.claimed(['highlight-annotation'])).metadata.id).toBe(jobId);
  });

  it('leaves a completed job complete: terminal states are absorbing', async () => {
    const { creator, worker, job, ref } = await world().running('highlight-annotation');
    await worker.complete(ref, HIGHLIGHTS);
    await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    await worker.fail(ref, 'too late');
    await worker.cancel(ref);
    await settle();
    expect(await creator.statusOf(job.metadata.id)).toMatchObject({ status: 'complete', result: HIGHLIGHTS });
  });
});

withDispatcher('job:fail', (world) => {
  it('retries a first failure of a job with budget: pending again, announced again, and claimed with one retry counted', async () => {
    const { creator, worker, job, ref } = await world().running('highlight-annotation');
    await world().announced(job.metadata.id);
    await worker.fail(ref, 'the model timed out');
    const status = await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    expect(status.startedAt).toBeUndefined();
    expect(status.error).toBeUndefined();
    await world().announced(job.metadata.id, 2);
    const retried = await worker.claimed(['highlight-annotation']);
    expect(retried.metadata).toMatchObject({ id: job.metadata.id, retryCount: 1, maxRetries: 1 });
    expect(retried.progress).toEqual({});
  });

  it('retries a failure classed transient as it does an unclassed one', async () => {
    const { creator, worker, job, ref } = await world().running('comment-annotation');
    await worker.fail(ref, 'rate limited', { failureClass: 'transient' });
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
  });

  it('fails a job whose budget is spent, recording the error and when', async () => {
    const { creator, worker, job, ref } = await world().running('highlight-annotation');
    await worker.fail(ref, 'first');
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    const retried = await worker.claimed(['highlight-annotation']);
    await worker.fail(ref, 'second, and last');
    const status = await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed');
    expect(status.error).toBe('second, and last');
    expect(Date.parse(status.completedAt!)).toBeGreaterThanOrEqual(Date.parse(retried.startedAt));
  });

  it('never retries a generation job', async () => {
    const { creator, worker, job, ref } = await world().running('generation');
    await worker.fail(ref, 'the model refused');
    expect((await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed')).error).toBe('the model refused');
  });

  it('fails at once a failure classed deterministic, whatever budget is left', async () => {
    const { creator, worker, job, ref } = await world().running('assessment-annotation');
    await worker.fail(ref, 'the resource is empty', { failureClass: 'deterministic' });
    await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed');
  });

  it('has no effect on a job that is not running', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('premature');
    const resourceId = resourceIdOf();
    const jobId = await creator.created('comment-annotation', {}, resourceId);
    await worker.fail({ jobId, jobType: 'comment-annotation', resourceId }, 'never started', { failureClass: 'deterministic' });
    await settle();
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await worker.claimed(['comment-annotation'])).metadata.retryCount).toBe(0);
  });

  it('carries the failure\'s finished units into the retry, with those already checkpointed', async () => {
    const { creator, worker, job, ref } = await world().running('reference-annotation');
    await worker.checkpoint(job.metadata.id, ['Person']);
    await settle();
    await worker.fail(ref, 'interrupted', { completedUnits: ['Place'] });
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    const retried = await worker.claimed(['reference-annotation']);
    expect([...retried.metadata.completedUnits!].sort()).toEqual(['Person', 'Place']);
  });

  it('carries the failure\'s cursors into the retry', async () => {
    const { creator, worker, job, ref } = await world().running('reference-annotation');
    const cursor = { next: 3, size: 10, found: 5, emitted: 4 };
    await worker.fail(ref, 'interrupted', { unitCursors: { Person: cursor } });
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    expect((await worker.claimed(['reference-annotation'])).metadata.unitCursors).toEqual({ Person: cursor });
  });
});
