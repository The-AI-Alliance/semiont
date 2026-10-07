/**
 * Claiming (JOBS.md § `job:claim`, § `job:assign`): only a worker may claim;
 * a claim names the jobs it takes by fields of the job description and is
 * atomic; nothing to claim is a decline; an accepted claim hands out the
 * whole running record and is recorded as an assignment.
 */
import { expect, it } from 'vitest';
import { everyJob, generation, marks, resourceIdOf, withDispatcher, YIELDS } from '../harness/dispatcher-world';

const NOT_A_WORKER = 'job:claim refused: the caller is not a worker for this knowledge base';

withDispatcher('job:claim', (world) => {
  it('hands a worker the whole running record, then records the assignment under the dispatcher\'s name', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('claimant');
    const resourceId = resourceIdOf();
    const params = { motivation: 'linking', entityTypes: ['Place'], includeDescriptiveReferences: true };
    const admitted = await creator.create('mark', params, resourceId);
    const jobId = (admitted.payload['response'] as { jobId: string }).jobId;

    const job = await worker.claimed([marks('linking')]);
    expect(job).toMatchObject({
      status: 'running',
      metadata: { id: jobId, type: 'mark', userId: creator.did, retryCount: 0, maxRetries: 1 },
      params: { resourceId, ...params },
      progress: {},
    });
    expect(Date.parse(job.startedAt)).not.toBeNaN();

    const assignment = await world().assigned(jobId);
    expect(assignment.payload).toMatchObject({ jobId, jobType: 'mark', resourceId, holder: worker.did, requester: creator.did });
    // Emitted as the dispatcher, the principal every reply of its comes from.
    expect(assignment.payload['_userId']).toBe(admitted.payload['_userId']);
    expect(assignment.payload['_userId']).not.toBe(worker.did);
  });

  it.each([
    ['a person', async () => world().person('not-a-worker')],
    ['a sidecar holding the service role only', async () => world().sidecar('not-a-worker')],
  ])('refuses %s, before the queue is consulted: the pending job stays for a worker', async (_who, who) => {
    const creator = await world().person('creator');
    const jobId = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    const answer = await (await who()).claim(everyJob());
    expect(answer.channel).toBe('job:claim-failed');
    expect(answer.payload).toMatchObject({ code: 'unauthorized', message: NOT_A_WORKER });
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await (await world().worker('rightful')).claimed(everyJob())).metadata.id).toBe(jobId);
  });

  it('refuses a person who writes the worker role into the claim: roles come from the token alone', async () => {
    const person = await world().person('pretender');
    await (await world().person('creator')).created('mark', { motivation: 'highlighting' }, resourceIdOf());
    const answer = await person.request('job:claim', { accepts: everyJob(), _roles: ['semiont-worker'] });
    expect(answer.payload).toMatchObject({ code: 'unauthorized', message: NOT_A_WORKER });
  });

  it('declines when nothing is pending, and records no assignment', async () => {
    const assignments = world().observer.frames('job:assign').length;
    const answer = await (await world().worker('early')).claim(everyJob());
    expect(answer.channel).toBe('job:claim-failed');
    expect(answer.payload).toMatchObject({ code: 'none-pending', message: 'No pending job matches the claim' });
    expect(world().observer.frames('job:assign').length).toBe(assignments);
  });

  it('hands a claim for one motivation no job of another, and no yield job', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('tagger');
    const highlighting = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    const yielding = await creator.created('yield', generation(resourceIdOf()));
    expect((await worker.claim([marks('tagging')])).payload['code']).toBe('none-pending');
    expect((await creator.statusOf(highlighting)).status).toBe('pending');
    expect((await creator.statusOf(yielding)).status).toBe('pending');

    const tagging = await creator.created('mark', { motivation: 'tagging', schemaId: 'irac', categories: ['Issue'] }, resourceIdOf());
    expect((await worker.claimed([marks('tagging')])).metadata.id).toBe(tagging);
    expect((await creator.statusOf(highlighting)).status).toBe('pending');
  });

  it('hands a claim for yield jobs no mark job', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('generator');
    const commenting = await creator.created('mark', { motivation: 'commenting' }, resourceIdOf());
    expect((await worker.claim([YIELDS])).payload['code']).toBe('none-pending');
    const yielding = await creator.created('yield', generation(resourceIdOf()));
    expect((await worker.claimed([YIELDS])).metadata.id).toBe(yielding);
    expect((await creator.statusOf(commenting)).status).toBe('pending');
  });

  it('hands over a job that matches any one of a claim\'s filters', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('picky');
    const jobId = await creator.created('mark', { motivation: 'commenting' }, resourceIdOf());
    expect((await worker.claim([marks('tagging'), YIELDS])).payload['code']).toBe('none-pending');
    expect((await creator.statusOf(jobId)).status).toBe('pending');
    expect((await worker.claimed([marks('tagging'), marks('commenting')])).metadata.id).toBe(jobId);
  });

  it.each([
    ['names no job', { accepts: [] }],
    ['names mark jobs of no motivation', { accepts: [{ jobType: 'mark' }] }],
    ['names a motivation that is none', { accepts: [{ jobType: 'mark', params: { motivation: 'unheard-of' } }] }],
    ['names jobs by a type alone, as claims once did', { types: ['mark'] }],
    ['states a field no filter states', { accepts: [{ jobType: 'yield', params: { title: 'A generated resource' } }] }],
  ])('refuses at the door a claim that %s', async (_what, claim) => {
    const worker = await world().worker('vague');
    expect((await worker.offered('job:claim', claim)).status).toBe(400);
  });

  it('gives one pending job to exactly one of many simultaneous claims', async () => {
    const creator = await world().person('creator');
    const workers = await Promise.all([1, 2, 3, 4, 5].map((n) => world().worker(`racer-${n}`)));
    for (let round = 0; round < 3; round++) {
      const jobId = await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
      const answers = await Promise.all(workers.map((w) => w.claim([marks('highlighting')])));
      const won = answers.filter((a) => a.ok);
      expect(won).toHaveLength(1);
      expect((won[0]!.payload['response'] as { metadata: { id: string } }).metadata.id).toBe(jobId);
      expect(answers.filter((a) => !a.ok).map((a) => a.payload['code'])).toEqual(['none-pending', 'none-pending', 'none-pending', 'none-pending']);
    }
  });

  it('gives two pending jobs to two simultaneous claims, one each', async () => {
    const creator = await world().person('creator');
    const ids = [await creator.created('mark', { motivation: 'assessing' }, resourceIdOf()), await creator.created('mark', { motivation: 'assessing' }, resourceIdOf())];
    const [a, b] = await Promise.all([world().worker('left'), world().worker('right')]);
    const claimed = await Promise.all([a!.claimed([marks('assessing')]), b!.claimed([marks('assessing')])]);
    expect(claimed.map((j) => j.metadata.id).sort()).toEqual([...ids].sort());
  });
});
