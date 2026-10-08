/**
 * Announcements (JOBS.md § `job:queued`): a pending job is announced with its
 * description less its input, which is what a claim is matched against. A
 * `mark` job's is every parameter it was created with; a `yield` job's is
 * what it is asked to make, without the context it is made from. Nothing the
 * dispatcher adds to the job it holds is announced.
 */
import { expect, it } from 'vitest';
import { generation, marks, resourceIdOf, withDispatcher, YIELDS } from '../harness/dispatcher-world';

withDispatcher('job:queued', (world) => {
  it('announces a mark job with every parameter it was created with, its motivation among them', async () => {
    const creator = await world().person('creator');
    const resourceId = resourceIdOf();
    const params = { motivation: 'commenting', instructions: 'what a first reader would ask', tone: 'explanatory', density: 4, language: 'de', sourceLanguage: 'en' };
    const jobId = await creator.created('mark', params, resourceId);
    expect((await world().announced(jobId)).payload).toMatchObject({ jobId, jobType: 'mark', resourceId, userId: creator.did });
    expect((await world().announced(jobId)).payload['params']).toEqual(params);
  });

  it('announces a tagging job as it was created, without the schema the dispatcher resolved for its worker', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('tagger');
    const params = { motivation: 'tagging', schemaId: 'irac', categories: ['Issue', 'Rule'] };
    const jobId = await creator.created('mark', params, resourceIdOf());
    expect((await world().announced(jobId)).payload['params']).toEqual(params);
    // The job a claim hands over does carry it.
    expect((await worker.claimed([marks('tagging')])).params).toHaveProperty('schema');
  });

  it('announces a yield job with what it is asked to make, and without its context', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('generator');
    const resourceId = resourceIdOf();
    const asked = { title: 'Ouranos', storageUri: 'file://generated/ouranos.md', prompt: 'in one page', entityTypes: ['Person'], language: 'en', maxTokens: 800, outputMediaType: 'text/markdown', task: 'summary', cite: true };
    const jobId = await creator.created('yield', generation(resourceId, asked));
    const announcement = (await world().announced(jobId)).payload;
    expect(announcement).toMatchObject({ jobId, jobType: 'yield', resourceId, userId: creator.did });
    expect(announcement['params']).toEqual(asked);
    // The job a claim hands over does carry it.
    expect((await worker.claimed([YIELDS])).params).toHaveProperty('context');
  });

  it('announces a retried job as it announced it first', async () => {
    const { creator, worker, job, ref } = await world().running({ motivation: 'tagging', schemaId: 'irac', categories: ['Issue'] });
    const first = (await world().announced(job.metadata.id)).payload;
    await worker.fail(ref, 'the model timed out');
    await creator.until(job.metadata.id, 'the job to be re-queued', (s) => s.status === 'pending');
    expect((await world().announced(job.metadata.id, 2)).payload).toEqual(first);
  });
});
