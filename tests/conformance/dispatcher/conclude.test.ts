/**
 * Concluding an attempt (JOBS.md § `job:complete`, § `job:fail`, § Retries):
 * completion, and a failure retried or final by the retry predicate, with the
 * checkpoint it carries merged either way. A conclusion names a job that must
 * be running; for anything else it has no effect.
 */
import { expect, it } from 'vitest';
import { marks, resourceIdOf, settle, withDispatcher } from '../harness/dispatcher-world';

const HIGHLIGHTS = { found: 4, persisted: 3, errors: 1 };

withDispatcher('job:complete', (world) => {
  it('completes a running job with its result, keeping the time it started', async () => {
    const { creator, worker, job, ref } = await world().running();
    await worker.complete(ref, HIGHLIGHTS);
    const status = await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    expect(status).toMatchObject({ startedAt: job.startedAt, result: HIGHLIGHTS });
    expect(Date.parse(status.completedAt!)).toBeGreaterThanOrEqual(Date.parse(job.startedAt));
    expect(status.progress).toBeUndefined();
  });

  it.each([
    ['counts under a motivation\'s own names', { highlightsFound: 4, highlightsCreated: 3 }],
    ['a kind beside its counts', { kind: 'highlight-annotation', found: 4, persisted: 3 }],
    ['counts and a resource at once', { found: 4, persisted: 3, resourceId: 'res-made', resourceName: 'Made', truncated: false }],
    ['a count of no errors, which is said by leaving it out', { found: 4, persisted: 4, errors: 0 }],
    ['a decline that says more', { declined: true, reason: 'empty', found: 0 }],
  ])('refuses at the door a completion whose result is %s: none of the three a job reports, and the job stays running', async (_what, result) => {
    const { creator, worker, job, ref } = await world().running();
    expect((await worker.offered('job:complete', { ...ref, result })).status).toBe(400);
    await settle();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('running');
  });

  it.each([
    ['a mark job the resource a yield job makes', undefined, { resourceId: 'res-made', resourceName: 'Made', truncated: false }],
    ['a yield job the counts a mark job reports', 'yield' as const, { found: 4, persisted: 3 }],
  ])('refuses at the door a completion that gives %s: a result is its verb\'s, and the job stays running', async (_what, verb, result) => {
    const { creator, worker, job, ref } = await world().running(verb);
    expect((await worker.offered('job:complete', { ...ref, result })).status).toBe(400);
    await settle();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('running');
  });

  it.each([
    ['a yield job\'s completion of a mark job', undefined, 'yield', { resourceId: 'res-made', resourceName: 'Made', truncated: false }],
    ['a mark job\'s completion of a yield job', 'yield' as const, 'mark', { found: 4, persisted: 3 }],
  ])('has no effect when it is %s: each is well formed for its own verb, and the job stays running until a completion of its own verb', async (_what, verb, completedAs, result) => {
    const { creator, worker, job, ref } = await world().running(verb);
    await worker.complete({ ...ref, jobType: completedAs }, result);
    await settle();
    expect((await creator.statusOf(job.metadata.id)).status).toBe('running');
    await worker.complete(ref);
    expect((await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete')).result).toEqual({});
  });

  it.each([
    ['a mark job\'s counts', undefined, { found: 4, persisted: 3, errors: 1, byCategory: { Issue: 2, Rule: 1 }, underReportedPieces: 1 }],
    ['the resource a yield job made', 'yield' as const, { resourceId: 'res-made', resourceName: 'Made', truncated: true }],
    ['a decline', undefined, { declined: true, reason: 'no-text-layer' }],
  ])('completes a job with %s, stored as it was sent', async (_what, job, result) => {
    const running = await world().running(job);
    await running.worker.complete(running.ref, result);
    const status = await running.creator.until(running.job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    expect(status.result).toEqual(result);
  });

  it('records an empty result when the completion carries none', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'commenting' });
    await worker.complete(ref);
    const status = await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
    expect(status.result).toEqual({});
  });

  it('has no effect on a job that is not running, and the dispatcher keeps serving', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('premature');
    const resourceId = resourceIdOf();
    const jobId = await creator.created('mark', { motivation: 'highlighting' }, resourceId);
    await worker.complete({ jobId, jobType: 'mark', resourceId }, HIGHLIGHTS);
    await worker.complete({ jobId: 'job-00000000000000000000000000000000', jobType: 'mark', resourceId }, HIGHLIGHTS);
    await settle();
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await worker.claimed([marks('highlighting')])).metadata.id).toBe(jobId);
  });

  it('leaves a completed job complete: terminal states are absorbing', async () => {
    const { creator, worker, job, ref } = await world().running();
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
    const { creator, worker, job, ref } = await world().running();
    await world().announced(job.metadata.id);
    await worker.fail(ref, 'the model timed out');
    const status = await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    expect(status.startedAt).toBeUndefined();
    expect(status.error).toBeUndefined();
    await world().announced(job.metadata.id, 2);
    const retried = await worker.claimed([marks('highlighting')]);
    expect(retried.metadata).toMatchObject({ id: job.metadata.id, retryCount: 1, maxRetries: 1 });
    expect(retried.progress).toEqual({});
  });

  it('retries a failure classed transient as it does an unclassed one', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'commenting' });
    await worker.fail(ref, 'rate limited', { failureClass: 'transient' });
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
  });

  it('fails a job whose budget is spent, recording the error and when', async () => {
    const { creator, worker, job, ref } = await world().running();
    await worker.fail(ref, 'first');
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    const retried = await worker.claimed([marks('highlighting')]);
    await worker.fail(ref, 'second, and last');
    const status = await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed');
    expect(status.error).toBe('second, and last');
    expect(Date.parse(status.completedAt!)).toBeGreaterThanOrEqual(Date.parse(retried.startedAt));
  });

  it('never retries a generation job', async () => {
    const { creator, worker, job, ref } = await world().running('yield');
    await worker.fail(ref, 'the model refused');
    expect((await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed')).error).toBe('the model refused');
  });

  it('fails at once a failure classed deterministic, whatever budget is left', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'assessing' });
    await worker.fail(ref, 'the resource is empty', { failureClass: 'deterministic' });
    await creator.until(job.metadata.id, 'the job to fail', (s) => s.status === 'failed');
  });

  it('has no effect on a job that is not running', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('premature');
    const resourceId = resourceIdOf();
    const jobId = await creator.created('mark', { motivation: 'commenting' }, resourceId);
    await worker.fail({ jobId, jobType: 'mark', resourceId }, 'never started', { failureClass: 'deterministic' });
    await settle();
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await worker.claimed([marks('commenting')])).metadata.retryCount).toBe(0);
  });

  it('carries the failure\'s finished units into the retry, with those already checkpointed', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'linking', entityTypes: ['Person', 'Place'] });
    await worker.checkpoint(job.metadata.id, ['Person']);
    await settle();
    await worker.fail(ref, 'interrupted', { completedUnits: ['Place'] });
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    const retried = await worker.claimed([marks('linking')]);
    expect([...retried.metadata.completedUnits!].sort()).toEqual(['Person', 'Place']);
  });

  it('carries the failure\'s cursors into the retry', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'linking', entityTypes: ['Person', 'Place'] });
    const cursor = { next: 3, size: 10, found: 5, emitted: 4, errors: 1 };
    await worker.fail(ref, 'interrupted', { unitCursors: { Person: cursor } });
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    expect((await worker.claimed([marks('linking')])).metadata.unitCursors).toEqual({ Person: cursor });
  });
});
