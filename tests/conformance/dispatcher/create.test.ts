/**
 * Admission (JOBS.md § `job:create`): what the gateway refuses at its door
 * because it is not a job description, the checks the dispatcher makes and
 * their refusals, the resource a job is recorded under, the two vocabulary
 * reads, and the record a claim then hands out.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { contextOf, descriptorOf, everyJob, generation, marks, resourceIdOf, VOCABULARY, withDispatcher, YIELDS, type DispatcherWorld, type MarkParams } from '../harness/dispatcher-world';

const ENTITY_TYPES = 'browse:entity-types-requested';
const TAG_SCHEMAS = 'browse:tag-schemas-requested';

const reads = (world: DispatcherWorld, channel: string) => world.browserReads.get(channel) ?? 0;

/** Nothing is pending: a claim that takes every job is told so. */
async function nothingQueued(world: DispatcherWorld): Promise<void> {
  expect((await (await world.worker('idle')).claim(everyJob())).payload['code']).toBe('none-pending');
}

/** A `mark` job, and a parameter beside its own that it does not take. */
const NOT_TAKEN: [string, MarkParams, Record<string, unknown>][] = [
  ['a linking job given instructions', { motivation: 'linking', entityTypes: ['Person'] }, { instructions: 'find who is related to whom' }],
  ['a tagging job given a density', { motivation: 'tagging', schemaId: 'irac', categories: ['Issue'] }, { density: 2 }],
  ['a highlighting job given a tone', { motivation: 'highlighting' }, { tone: 'scholarly' }],
  ['a commenting job given an assessment\'s tone', { motivation: 'commenting' }, { tone: 'critical' }],
  ['an assessing job given entity types', { motivation: 'assessing' }, { entityTypes: ['Person'] }],
  ['a job given the resource among its parameters', { motivation: 'highlighting' }, { resourceId: 'res-caller' }],
];

withDispatcher('job:create', (world) => {
  it('records the requester, a fresh id, no retries yet and a budget by type', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('creation');

    const markId = await creator.created('mark', { motivation: 'commenting' }, resourceIdOf());
    const marked = await worker.claimed([marks('commenting')]);
    expect(marked.metadata).toMatchObject({ id: markId, type: 'mark', userId: creator.did, retryCount: 0, maxRetries: 1 });
    expect(Date.parse(marked.metadata.created)).not.toBeNaN();

    const yieldId = await creator.created('yield', generation(resourceIdOf()));
    const yielded = await worker.claimed([YIELDS]);
    expect(yielded.metadata).toMatchObject({ id: yieldId, type: 'yield', userId: creator.did, retryCount: 0, maxRetries: 0 });
    expect(yieldId).not.toBe(markId);

    expect((await creator.statusOf(markId)).userId).toBe(creator.did);
    expect((await world().assigned(yieldId)).payload['requester']).toBe(creator.did);
  });

  it.each(NOT_TAKEN)('refuses %s at the door, a parameter that job does not take, and queues nothing', async (_what, params, extra) => {
    const creator = await world().person('creator');
    const worker = await world().worker('taker');
    const resourceId = resourceIdOf();
    const refused = await creator.offered('job:create', { jobType: 'mark', resourceId, params: { ...params, ...extra } });
    expect(refused.status).toBe(400);
    await nothingQueued(world());
    // The same job without it is one.
    const jobId = await creator.created('mark', params, resourceId);
    expect((await worker.claimed([marks(params.motivation)])).metadata.id).toBe(jobId);
  });

  it.each([
    ['a tagging job with an empty schemaId', { motivation: 'tagging', schemaId: '', categories: ['Issue'] }],
    ['a tagging job with no category', { motivation: 'tagging', schemaId: 'irac', categories: [] }],
    ['a tagging job with no schemaId', { motivation: 'tagging', categories: ['Issue'] }],
    ['a linking job with no entity type', { motivation: 'linking', entityTypes: [] }],
    ['a linking job that names no entity types', { motivation: 'linking' }],
    ['a job of no motivation', {}],
    ['a job of a motivation no job has', { motivation: 'bookmarking' }],
  ])('refuses %s at the door: a value a job needs is stated, and not empty', async (_what, params) => {
    const creator = await world().person('creator');
    const before = reads(world(), TAG_SCHEMAS) + reads(world(), ENTITY_TYPES);
    const refused = await creator.offered('job:create', { jobType: 'mark', resourceId: resourceIdOf(), params });
    expect(refused.status).toBe(400);
    expect(reads(world(), TAG_SCHEMAS) + reads(world(), ENTITY_TYPES)).toBe(before);
    await nothingQueued(world());
  });

  it('refuses at the door a mark job that names no resource, and queues nothing', async () => {
    const creator = await world().person('creator');
    const refused = await creator.offered('job:create', { jobType: 'mark', params: { motivation: 'highlighting' } });
    expect(refused.status).toBe(400);
    await nothingQueued(world());
  });

  it('records a yield job under the resource its context focuses', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('generator');
    const resourceId = resourceIdOf();

    const jobId = await creator.created('yield', generation(resourceId));
    expect((await world().announced(jobId)).payload['resourceId']).toBe(resourceId);
    const job = await worker.claimed([YIELDS]);
    expect(job.params.resourceId).toBe(resourceId);
    expect((await world().assigned(jobId)).payload['resourceId']).toBe(resourceId);
  });

  it('records a yield job focused on an annotation under the resource the annotation is on', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('generator');
    const sourceResource = resourceIdOf();
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: `ann-${randomUUID()}`,
      motivation: 'linking',
      target: sourceResource,
      created: new Date().toISOString(),
    };
    const params = generation('unused', { context: contextOf({ kind: 'annotation', annotation, sourceResource: descriptorOf(sourceResource) }) });

    await creator.created('yield', params);
    expect((await worker.claimed([YIELDS])).params.resourceId).toBe(sourceResource);
  });

  it.each([
    ['a resourceId beside the context', { resourceId: 'res-caller' }, {}],
    ['an empty storageUri', {}, { storageUri: '' }],
    ['an empty title', {}, { title: '' }],
    ['no title', {}, { title: undefined }],
    ['no context', {}, { context: undefined }],
    ['a context with no usable focus', {}, { context: contextOf({ kind: 'nothing' }) }],
  ])('refuses at the door a yield job with %s, and queues nothing', async (_what, envelope, change) => {
    const creator = await world().person('creator');
    const params = JSON.parse(JSON.stringify({ ...generation(resourceIdOf()), ...change })) as Record<string, unknown>;
    const refused = await creator.offered('job:create', { jobType: 'yield', params, ...envelope });
    expect(refused.status).toBe(400);
    await nothingQueued(world());
  });

  it.each([
    ['a referenceId', { referenceId: 'ref-caller' }, 'a yield job takes no parameter referenceId'],
    ['a resourceId', { resourceId: 'res-caller' }, 'a yield job takes no parameter resourceId'],
    ['two it does not take', { schemaId: 'irac', instructions: 'be brief' }, 'a yield job takes no parameter schemaId, instructions'],
  ])('refuses a yield job given %s among its parameters: the context\'s focus is what it is about, and it takes what a yield job takes', async (_what, extra, message) => {
    const creator = await world().person('creator');
    const answer = await creator.create('yield', generation(resourceIdOf(), extra));
    expect(answer.channel).toBe('job:create-failed');
    expect(answer.payload['message']).toBe(message);
    await nothingQueued(world());
  });

  it('admits entity types the knowledge base registers, reading them afresh for every job', async () => {
    const creator = await world().person('creator');
    const before = reads(world(), ENTITY_TYPES);
    await creator.created('mark', { motivation: 'linking', entityTypes: VOCABULARY.entityTypes }, resourceIdOf());
    await creator.created('yield', generation(resourceIdOf(), { entityTypes: ['Person'] }));
    expect(reads(world(), ENTITY_TYPES)).toBe(before + 2);
  });

  it('refuses entity types the knowledge base does not register, naming every one, and queues nothing', async () => {
    const creator = await world().person('creator');
    const linking = await creator.create('mark', { motivation: 'linking', entityTypes: ['Person', 'Unicorn', 'Dragon'] }, resourceIdOf());
    expect(linking.channel).toBe('job:create-failed');
    expect(linking.payload['message']).toBe('Entity type not registered: Unicorn, Dragon');
    expect(linking.payload['code']).toBeUndefined();

    const yielded = await creator.create('yield', generation(resourceIdOf(), { entityTypes: ['UnknownThing'] }));
    expect(yielded.payload['message']).toBe('Entity type not registered: UnknownThing');
    await nothingQueued(world());
  });

  it('does not read the entity types for a job that names none', async () => {
    const creator = await world().person('creator');
    const before = reads(world(), ENTITY_TYPES);
    await creator.created('yield', generation(resourceIdOf()));
    await creator.created('yield', generation(resourceIdOf(), { entityTypes: [] }));
    await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    expect(reads(world(), ENTITY_TYPES)).toBe(before);
  });

  it('resolves a tagging job\'s schemaId into the schema itself, beside it, so its worker needs no registry', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('tagger');
    const resourceId = resourceIdOf();
    const params = { motivation: 'tagging', schemaId: 'irac', categories: ['Issue'], language: 'en' };
    await creator.created('mark', params, resourceId);
    const job = await worker.claimed([marks('tagging')]);
    expect(job.params).toEqual({ resourceId, ...params, schema: VOCABULARY.tagSchemas[0] });
  });

  it('refuses a tagging job whose schema the knowledge base does not register, having read the schemas', async () => {
    const creator = await world().person('creator');
    const before = reads(world(), TAG_SCHEMAS);
    const unknown = await creator.create('mark', { motivation: 'tagging', schemaId: 'nope', categories: ['Issue'] }, resourceIdOf());
    expect(unknown.channel).toBe('job:create-failed');
    expect(unknown.payload['message']).toBe('Tag schema not registered: nope');
    expect(reads(world(), TAG_SCHEMAS)).toBe(before + 1);
    expect((await (await world().worker('idle')).claim([marks('tagging')])).payload['code']).toBe('none-pending');
  });

  it('holds every other job\'s params as given, with its resource, and reads no tag schemas', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('assessor');
    const before = reads(world(), TAG_SCHEMAS);
    const resourceId = resourceIdOf();
    const params = { motivation: 'assessing', instructions: 'be kind', tone: 'constructive', density: 2 };
    await creator.created('mark', params, resourceId);
    expect((await worker.claimed([marks('assessing')])).params).toEqual({ resourceId, ...params });
    expect(reads(world(), TAG_SCHEMAS)).toBe(before);
  });
});

withDispatcher('job:create with the Archivist absent', (world) => {
  it('refuses at once a job that needs a vocabulary read, naming the read and carrying peer-unavailable', async () => {
    const creator = await world().person('creator');
    for (const [params, read] of [
      [{ motivation: 'linking', entityTypes: ['Person'] }, ENTITY_TYPES],
      [{ motivation: 'tagging', schemaId: 'irac', categories: ['Issue'] }, TAG_SCHEMAS],
    ] as const) {
      const started = Date.now();
      const answer = await creator.create('mark', params, resourceIdOf());
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(answer.channel).toBe('job:create-failed');
      expect(answer.payload).toMatchObject({
        message: `No subscriber for ${read}: the service that answers it is not connected`,
        code: 'peer-unavailable',
      });
    }
  });

  it('admits a job that needs no read', async () => {
    const creator = await world().person('creator');
    await creator.created('mark', { motivation: 'highlighting' }, resourceIdOf());
    await creator.created('yield', generation(resourceIdOf()));
  });
}, { vocabulary: null });
