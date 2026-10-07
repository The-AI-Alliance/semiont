/**
 * A job's life, end to end (JOBS.md § The job record, § Channels): admitted,
 * announced, claimed and recorded, completed, and read back.
 */
import { expect, it } from 'vitest';
import { marks, refOf, resourceIdOf, withDispatcher } from '../harness/dispatcher-world';

withDispatcher('a job from admission to completion', (world) => {
  it('is admitted, announced, claimed, recorded as assigned, completed and read back', async () => {
    const creator = await world().person('alice');
    const worker = await world().worker('highlighter');
    const resourceId = resourceIdOf();

    const params = { motivation: 'highlighting', density: 3 };
    const jobId = await creator.created('mark', params, resourceId);
    expect(jobId).toMatch(/^job-[0-9a-f]{32}$/);

    const announcement = await world().announced(jobId);
    expect(announcement.payload).toMatchObject({ jobId, jobType: 'mark', resourceId, userId: creator.did, params });

    const job = await worker.claimed([marks('highlighting')]);
    expect(job.metadata).toMatchObject({ id: jobId, type: 'mark', userId: creator.did, retryCount: 0, maxRetries: 1 });
    expect(job.params).toEqual({ resourceId, ...params });
    expect(job.status).toBe('running');
    expect(job.progress).toEqual({});

    const assignment = await world().assigned(jobId);
    expect(assignment.payload).toMatchObject({ jobId, jobType: 'mark', resourceId, holder: worker.did, requester: creator.did });
    expect(assignment.correlationId).toBeUndefined();

    const result = { found: 2, persisted: 2 };
    await worker.complete(refOf(job), result);
    const status = await creator.until(jobId, 'the job to complete', (s) => s.status === 'complete');
    expect(status).toMatchObject({ jobId, type: 'mark', userId: creator.did, startedAt: job.startedAt, result });
    expect(status.completedAt).toBeDefined();
  });
});
