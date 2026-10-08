/**
 * Jobs in the record (ARCHIVIST.md § Attribution, § Vocabulary, people and
 * jobs): the lifecycle the dispatcher and a worker report, recorded in the
 * resource's stream, and a worker's writes attributed to whoever the job was
 * assigned for.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sha256, withArchivist, type Annotation, type ArchivistWorld, type BusClient } from '../harness/archivist-world';
import { eventually } from '../harness/net';

const TEXT = 'A worker reads this and marks it up.\n';

function whole(resourceId: string, exact: string, extra: Record<string, unknown> = {}): Annotation {
  const start = TEXT.indexOf(exact);
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: randomUUID().replaceAll('-', '') as Annotation['id'],
    motivation: 'highlighting',
    target: { source: resourceId, selector: [{ type: 'TextPositionSelector', start, end: start + exact.length }, { type: 'TextQuoteSelector', exact }] },
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as unknown as Annotation;
}

/** A resource, and a job on it assigned to `worker` for `requester`, as the dispatcher records a claim. */
async function assigned(world: ArchivistWorld, worker: BusClient, requester: BusClient, jobType: 'mark' | 'yield' = 'mark'): Promise<{ id: string; jobId: string }> {
  const id = await world.created(requester.did, { name: 'Worked on', storageUri: `file://jobs/${randomUUID()}.md`, content: TEXT });
  const jobId = `job-${randomUUID()}`;
  const dispatcher = await world.sidecar('dispatcher');
  await dispatcher.emit('job:assign', { jobId, jobType, resourceId: id, holder: worker.did, requester: requester.did });
  await eventually('the assignment to be recorded', 10_000, () => world.stored(id).find((e) => e.type === 'job:assigned'));
  return { id, jobId };
}

withArchivist('a job, in the record', (world) => {
  it('has its lifecycle recorded in its resource\'s stream', async () => {
    const worker = await world().worker('lifecycle');
    const requester = await world().person('requester');
    const { id, jobId } = await assigned(world(), worker, requester);
    const follower = await world().person('follower', { scopes: [id] });

    // Each is recorded before the next is sent: the channels are not ordered against each other.
    await worker.emit('job:start', { resourceId: id, jobId, jobType: 'mark' });
    await eventually('the start', 10_000, () => world().stored(id).find((e) => e.type === 'job:started'));
    await worker.emit('job:fail', { resourceId: id, jobId, jobType: 'mark', error: 'the model was unavailable', attempt: 1, failureClass: 'transient', willRetry: true });
    await eventually('the failure', 10_000, () => world().stored(id).find((e) => e.type === 'job:failed'));
    await worker.emit('job:complete', { resourceId: id, jobId, jobType: 'mark', attempt: 2, result: { found: 2, persisted: 1, errors: 1 } });
    await eventually('the completion', 10_000, () => world().stored(id).find((e) => e.type === 'job:completed'));

    const events = world().stored(id).slice(1);
    expect(events.map((e) => [e.type, e.metadata.sequenceNumber])).toEqual([['job:assigned', 2], ['job:started', 3], ['job:failed', 4], ['job:completed', 5]]);
    expect(events[0]).toMatchObject({ payload: { jobId, jobType: 'mark', resourceId: id, holder: worker.did, requester: requester.did } });
    expect(events[1]).toMatchObject({ userId: worker.did, payload: { jobId, jobType: 'mark' } });
    expect(events[2]).toMatchObject({ userId: worker.did, payload: { jobId, error: 'the model was unavailable', attempt: 1, failureClass: 'transient', willRetry: true } });
    expect(events[3]).toMatchObject({ userId: worker.did, payload: { jobId, attempt: 2, result: { found: 2, persisted: 1, errors: 1 } } });

    // Each is published to the resource's scope.
    const completed = await follower.stream.next('the scoped completion', (m) => m.frame?.channel === 'job:completed' && m.frame.scope === id);
    expect(completed.id).toBe(`p-${id}-5`);

    // The view counts them and is otherwise unchanged.
    expect(world().view(id)).toMatchObject({ lastSequence: 5, annotations: { version: 5, annotations: [] }, resource: { archived: false } });
  });

  const COUNTS = { found: 2, persisted: 2 };
  const MADE = { resourceId: 'res-made', resourceName: 'Made', truncated: false };

  // Frames of one channel are recorded in the order they arrive, so once the
  // job's own completion is stored, the one sent before it has been handled.
  it.each([
    ['a mark job, and a yield job\'s completion', 'mark', COUNTS, 'yield', MADE],
    ['a yield job, and a mark job\'s completion', 'yield', MADE, 'mark', COUNTS],
  ] as const)('records no completion of another verb than the job\'s: %s, each well formed for its own verb', async (_what, verb, own, otherVerb, others) => {
    const worker = await world().worker('other-verb');
    const requester = await world().person('requester');
    const { id, jobId } = await assigned(world(), worker, requester, verb);
    await worker.emit('job:start', { resourceId: id, jobId, jobType: verb });
    await eventually('the start', 10_000, () => world().stored(id).find((e) => e.type === 'job:started'));

    await worker.emit('job:complete', { resourceId: id, jobId, jobType: otherVerb, result: others });
    await worker.emit('job:complete', { resourceId: id, jobId, jobType: verb, result: own });
    await eventually('the job\'s own completion', 10_000, () => world().stored(id).find((e) => e.type === 'job:completed' && e.payload['jobType'] === verb));

    expect(world().stored(id).filter((e) => e.type === 'job:completed').map((e) => e.payload)).toEqual([{ jobId, jobType: verb, result: own }]);
    // It says so, in the words the dispatcher says it in. Its log reaches
    // this suite by a pipe, which can trail what it has already stored.
    const said = () => world().archivist.output.filter((line) => line.includes('job:complete of another verb than the job\'s') && line.includes(jobId));
    await eventually('the Archivist to say so', 10_000, () => (said().length > 0 ? true : undefined));
    expect(said()).toHaveLength(1);
  });

  it('learns a job\'s verb from its start when it recorded no assignment of it', async () => {
    const worker = await world().worker('unassigned');
    const requester = await world().person('requester');
    const id = await world().created(requester.did, { name: 'Worked on', storageUri: `file://jobs/${randomUUID()}.md`, content: TEXT });
    const jobId = `job-${randomUUID()}`;
    await worker.emit('job:start', { resourceId: id, jobId, jobType: 'mark' });
    await eventually('the start', 10_000, () => world().stored(id).find((e) => e.type === 'job:started'));

    await worker.emit('job:complete', { resourceId: id, jobId, jobType: 'yield', result: MADE });
    await worker.emit('job:complete', { resourceId: id, jobId, jobType: 'mark', result: COUNTS });
    await eventually('the job\'s own completion', 10_000, () => world().stored(id).find((e) => e.type === 'job:completed' && e.payload['jobType'] === 'mark'));
    expect(world().stored(id).filter((e) => e.type === 'job:completed').map((e) => e.payload['jobType'])).toEqual(['mark']);
  });

  it('records a completion of a job it has recorded nothing of, whichever verb\'s it is: it refuses only what its own record shows is another verb\'s', async () => {
    const worker = await world().worker('unheard-of');
    const requester = await world().person('requester');
    // Another job of the other verb is recorded on the same resource: it says nothing of this one.
    const { id } = await assigned(world(), worker, requester, 'mark');
    const jobId = `job-${randomUUID()}`;

    await worker.emit('job:complete', { resourceId: id, jobId, jobType: 'yield', result: MADE });
    await eventually('the completion', 10_000, () => world().stored(id).find((e) => e.type === 'job:completed'));
    expect(world().stored(id).filter((e) => e.type === 'job:completed').map((e) => e.payload)).toEqual([{ jobId, jobType: 'yield', result: MADE }]);
  });

  it('attributes a worker\'s annotations to whoever the job was assigned for, with the worker as generator', async () => {
    const worker = await world().worker('annotator');
    const requester = await world().person('requester');
    const { id, jobId } = await assigned(world(), worker, requester);
    const batch = [whole(id, 'worker'), whole(id, 'marks')];

    expect(await worker.ask('mark:commit', { resourceId: id, jobId, annotations: batch })).toEqual({ persisted: 2, annotationIds: batch.map((a) => a.id) });

    const recorded = world().stored(id).filter((e) => e.type === 'mark:added');
    expect(recorded).toHaveLength(2);
    for (const event of recorded) {
      expect(event.userId).toBe(worker.did);
      expect(event.payload['annotation']).toMatchObject({
        creator: { '@type': 'Person', '@id': requester.did },
        generator: { '@type': 'Software', '@id': worker.did, provider: 'conformance', model: 'annotator' },
        wasAttributedTo: [{ '@id': requester.did }, { '@id': worker.did }],
      });
    }
  });

  it('refuses a worker\'s write that cites no job, a job never assigned, or a job another holds', async () => {
    const worker = await world().worker('refused');
    const other = await world().worker('another');
    const requester = await world().person('requester');
    const { id, jobId } = await assigned(world(), worker, requester);
    const before = world().stored(id).length;

    expect(await worker.refused('mark:commit', { resourceId: id, annotations: [whole(id, 'worker')] })).toBe(
      'mark:commit refused: a worker-role emitter must cite the job it fulfils in `jobId`',
    );
    const unassigned = `job-${randomUUID()}`;
    expect(await worker.refused('mark:commit', { resourceId: id, jobId: unassigned, annotations: [whole(id, 'worker')] })).toBe(
      `refused: cites job ${unassigned}, but this resource's log holds no assignment for it`,
    );
    expect(await other.refused('mark:commit', { resourceId: id, jobId, annotations: [whole(id, 'worker')] })).toBe(
      `refused: job ${jobId}'s recorded holder is ${worker.did}, not the writer ${other.did}`,
    );
    expect(world().stored(id)).toHaveLength(before);
  });

  it('refuses a generator that is not the executor, and one from a person', async () => {
    const worker = await world().worker('generator');
    const requester = await world().person('requester');
    const { id, jobId } = await assigned(world(), worker, requester);
    const stranger = { '@type': 'Software', '@id': `did:web:${world().world.kb.domain}:agents:conformance:someone-else`, name: 'conformance someone-else', provider: 'conformance', model: 'someone-else' };

    expect(await worker.refused('mark:commit', { resourceId: id, jobId, annotations: [whole(id, 'worker', { generator: stranger })] })).toBe(
      `attribution: generator ${stranger['@id']} is not the executor ${worker.did}`,
    );
    expect(await requester.refused('mark:commit', { resourceId: id, annotations: [whole(id, 'worker', { generator: stranger })] })).toBe(
      `attribution: a generator was supplied, but the executor ${requester.did} is not software`,
    );
    const many = whole(id, 'worker', { generator: [stranger, stranger] });
    expect(await worker.refused('mark:commit', { resourceId: id, jobId, annotations: [many] })).toBe(
      `mark:commit refused: annotation ${many.id} carries a multi-agent generator; derivation binds one generator to the executor`,
    );
  });

  it('attributes a generated resource to whoever the generation was assigned for', async () => {
    const worker = await world().worker('writer');
    const requester = await world().person('requester');
    const { id, jobId } = await assigned(world(), worker, requester, 'yield');
    const content = 'Generated prose.\n';
    const uri = `file://jobs/generated-${randomUUID()}.md`;

    const uploaded = await world().upload(worker.did, { name: 'Generated', storageUri: uri, content, jobId, sourceResourceId: id, generationPrompt: 'Write about it' }, ['semiont-service', 'semiont-worker']);
    expect(uploaded.status).toBe(200);
    const generated = (uploaded.json as { resourceId: string }).resourceId;
    expect(world().stored(generated)[0]).toMatchObject({
      type: 'yield:created',
      userId: worker.did,
      payload: {
        contentChecksum: sha256(content),
        creator: { '@type': 'Person', '@id': requester.did },
        generator: { '@type': 'Software', '@id': worker.did },
        wasAttributedTo: [{ '@id': requester.did }, { '@id': worker.did }],
      },
    });
    expect(world().view(generated)!.resource).toMatchObject({ generator: { '@id': worker.did }, wasAttributedTo: [{ '@id': requester.did }, { '@id': worker.did }] });

    // Without the job, or without the resource the job was assigned on, a worker's upload is not recorded.
    const uncited = await world().upload(worker.did, { name: 'Uncited', storageUri: `file://jobs/uncited-${randomUUID()}.md`, content }, ['semiont-service', 'semiont-worker']);
    expect(uncited.status).toBe(500);
    expect(uncited.json).toEqual({ error: 'yield:create refused: a worker-role emitter must cite the job it fulfils in `jobId`' });
    const sourceless = await world().upload(worker.did, { name: 'Sourceless', storageUri: `file://jobs/sourceless-${randomUUID()}.md`, content, jobId }, ['semiont-service', 'semiont-worker']);
    expect(sourceless.status).toBe(500);
    expect(sourceless.json).toEqual({ error: 'yield:create refused: a create citing a job must name the source resource its job was assigned on (generatedFrom.resourceId)' });
  });
});
