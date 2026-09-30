/**
 * Claiming (JOBS.md § `job:claim`, § `job:assign`): only a worker may claim;
 * a claim is by type and atomic; nothing to claim is a decline; an accepted
 * claim hands out the whole running record and is recorded as an assignment.
 */
import { expect, it } from 'vitest';
import { resourceIdOf, withDispatcher } from '../harness/dispatcher-world';

const NOT_A_WORKER = 'job:claim refused: the caller is not a worker for this knowledge base';

withDispatcher('job:claim', (world) => {
  it('hands a worker the whole running record, then records the assignment under the dispatcher\'s name', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('claimant');
    const resourceId = resourceIdOf();
    const admitted = await creator.create('reference-annotation', { entityTypes: ['Place'], includeDescriptiveReferences: true }, resourceId);
    const jobId = (admitted.payload['response'] as { jobId: string }).jobId;

    const job = await worker.claimed(['reference-annotation']);
    expect(job).toMatchObject({
      status: 'running',
      metadata: { id: jobId, type: 'reference-annotation', userId: creator.did, retryCount: 0, maxRetries: 1 },
      params: { resourceId, entityTypes: ['Place'], includeDescriptiveReferences: true },
      progress: {},
    });
    expect(Date.parse(job.startedAt)).not.toBeNaN();

    const assignment = await world().assigned(jobId);
    expect(assignment.payload).toMatchObject({ jobId, jobType: 'reference-annotation', resourceId, holder: worker.did, requester: creator.did });
    // Emitted as the dispatcher, the principal every reply of its comes from.
    expect(assignment.payload['_userId']).toBe(admitted.payload['_userId']);
    expect(assignment.payload['_userId']).not.toBe(worker.did);
  });

  it.each([
    ['a person', async () => world().person('not-a-worker')],
    ['a sidecar holding the service role only', async () => world().sidecar('not-a-worker')],
  ])('refuses %s, before the queue is consulted: the pending job stays for a worker', async (_who, who) => {
    const creator = await world().person('creator');
    const jobId = await creator.created('highlight-annotation', {}, resourceIdOf());
    const answer = await (await who()).claim([]);
    expect(answer.channel).toBe('job:claim-failed');
    expect(answer.payload).toMatchObject({ code: 'unauthorized', message: NOT_A_WORKER });
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await (await world().worker('rightful')).claimed([])).metadata.id).toBe(jobId);
  });

  it('refuses a person who writes the worker role into the claim: roles come from the token alone', async () => {
    const person = await world().person('pretender');
    await (await world().person('creator')).created('highlight-annotation', {}, resourceIdOf());
    const answer = await person.request('job:claim', { types: [], _roles: ['semiont-worker'] });
    expect(answer.payload).toMatchObject({ code: 'unauthorized', message: NOT_A_WORKER });
  });

  it('declines when nothing is pending, and records no assignment', async () => {
    const assignments = world().observer.frames('job:assign').length;
    const answer = await (await world().worker('early')).claim([]);
    expect(answer.channel).toBe('job:claim-failed');
    expect(answer.payload).toMatchObject({ code: 'none-pending', message: 'No pending job of the requested types' });
    expect(world().observer.frames('job:assign').length).toBe(assignments);
  });

  it('claims only the requested types, and any type when none is named', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('picky');
    const jobId = await creator.created('comment-annotation', {}, resourceIdOf());
    expect((await worker.claim(['tag-annotation', 'generation'])).payload['code']).toBe('none-pending');
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await worker.claimed([])).metadata.id).toBe(jobId);
  });

  it('gives one pending job to exactly one of many simultaneous claims', async () => {
    const creator = await world().person('creator');
    const workers = await Promise.all([1, 2, 3, 4, 5].map((n) => world().worker(`racer-${n}`)));
    for (let round = 0; round < 3; round++) {
      const jobId = await creator.created('highlight-annotation', {}, resourceIdOf());
      const answers = await Promise.all(workers.map((w) => w.claim(['highlight-annotation'])));
      const won = answers.filter((a) => a.ok);
      expect(won).toHaveLength(1);
      expect((won[0]!.payload['response'] as { metadata: { id: string } }).metadata.id).toBe(jobId);
      expect(answers.filter((a) => !a.ok).map((a) => a.payload['code'])).toEqual(['none-pending', 'none-pending', 'none-pending', 'none-pending']);
    }
  });

  it('gives two pending jobs to two simultaneous claims, one each', async () => {
    const creator = await world().person('creator');
    const ids = [await creator.created('assessment-annotation', {}, resourceIdOf()), await creator.created('assessment-annotation', {}, resourceIdOf())];
    const [a, b] = await Promise.all([world().worker('left'), world().worker('right')]);
    const claimed = await Promise.all([a!.claimed(['assessment-annotation']), b!.claimed(['assessment-annotation'])]);
    expect(claimed.map((j) => j.metadata.id).sort()).toEqual([...ids].sort());
  });
});
