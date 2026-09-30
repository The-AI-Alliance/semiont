/**
 * A job's life, end to end (JOBS.md § The job record, § Channels): admitted,
 * announced, claimed and recorded, completed, and read back.
 */
import { expect, it } from 'vitest';
import { refOf, resourceIdOf, withDispatcher } from '../harness/dispatcher-world';

withDispatcher('a job from admission to completion', (world) => {
  it('is admitted, announced, claimed, recorded as assigned, completed and read back', async () => {
    const creator = await world().person('alice');
    const worker = await world().worker('highlighter');
    const resourceId = resourceIdOf();

    const jobId = await creator.created('highlight-annotation', { density: 3 }, resourceId);
    expect(jobId).toMatch(/^job-[0-9a-f]{32}$/);

    const announcement = await world().announced(jobId);
    expect(announcement.payload).toMatchObject({ jobId, jobType: 'highlight-annotation', resourceId, userId: creator.did });

    const job = await worker.claimed(['highlight-annotation']);
    expect(job.metadata).toMatchObject({ id: jobId, type: 'highlight-annotation', userId: creator.did, retryCount: 0, maxRetries: 1 });
    expect(job.params).toEqual({ resourceId, density: 3 });
    expect(job.status).toBe('running');
    expect(job.progress).toEqual({});

    const assignment = await world().assigned(jobId);
    expect(assignment.payload).toMatchObject({ jobId, jobType: 'highlight-annotation', resourceId, holder: worker.did, requester: creator.did });
    expect(assignment.correlationId).toBeUndefined();

    const result = { kind: 'highlight-annotation', highlightsFound: 2, highlightsCreated: 2 };
    await worker.complete(refOf(job), result);
    const status = await creator.until(jobId, 'the job to complete', (s) => s.status === 'complete');
    expect(status).toMatchObject({ jobId, type: 'highlight-annotation', userId: creator.did, startedAt: job.startedAt, result });
    expect(status.completedAt).toBeDefined();
  });
});
