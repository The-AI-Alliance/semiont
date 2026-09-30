/**
 * Reading a job (JOBS.md § `job:status-requested`): what the status carries
 * in each state, and a refusal for a job the dispatcher does not know.
 */
import { expect, it } from 'vitest';
import { resourceIdOf, withDispatcher } from '../harness/dispatcher-world';

const FIELDS = ['startedAt', 'completedAt', 'error', 'progress', 'result'] as const;

/** The conditional fields a status carries. */
const conditional = (status: Record<string, unknown>) => FIELDS.filter((f) => f in status);

withDispatcher('job:status-requested', (world) => {
  it('answers a job it does not know with Job not found', async () => {
    const answer = await (await world().person('reader')).status('job-00000000000000000000000000000000');
    expect(answer.channel).toBe('job:status-failed');
    expect(answer.payload['message']).toBe('Job not found');
    expect(answer.payload['code']).toBeUndefined();
  });

  it('carries, in every state, who asked for the job and when, and only the fields that state has', async () => {
    const creator = await world().person('creator');
    const pendingId = await creator.created('comment-annotation', {}, resourceIdOf());
    const pending = await creator.statusOf(pendingId);
    expect(pending).toMatchObject({ jobId: pendingId, type: 'comment-annotation', status: 'pending', userId: creator.did });
    expect(Date.parse(pending.created)).not.toBeNaN();
    expect(conditional(pending)).toEqual([]);

    const worker = await world().worker('reporter');
    const job = await worker.claimed(['comment-annotation']);
    expect(conditional(await creator.statusOf(pendingId))).toEqual(['startedAt', 'progress']);

    const complete = await world().running('highlight-annotation');
    await complete.worker.complete(complete.ref, { kind: 'highlight-annotation', highlightsFound: 1, highlightsCreated: 1 });
    expect(conditional(await creator.until(complete.job.metadata.id, 'completion', (s) => s.status === 'complete'))).toEqual(['startedAt', 'completedAt', 'result']);

    await worker.fail({ jobId: job.metadata.id, jobType: job.metadata.type, resourceId: job.params.resourceId }, 'broken', { failureClass: 'deterministic' });
    expect(conditional(await creator.until(pendingId, 'failure', (s) => s.status === 'failed'))).toEqual(['completedAt', 'error']);

    const cancelledId = await creator.created('comment-annotation', {}, resourceIdOf());
    await creator.cancelRequest({ jobId: cancelledId });
    expect(conditional(await creator.statusOf(cancelledId))).toEqual(['completedAt']);
  });
});
