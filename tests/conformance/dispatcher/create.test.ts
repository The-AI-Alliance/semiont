/**
 * Admission (JOBS.md § `job:create`): the checks and their refusals, the
 * resource a job is recorded under, the two vocabulary reads, and the record a
 * claim then hands out.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { generation, resourceIdOf, VOCABULARY, withDispatcher, type DispatcherWorld } from '../harness/dispatcher-world';

const ENTITY_TYPES = 'browse:entity-types-requested';
const TAG_SCHEMAS = 'browse:tag-schemas-requested';

const reads = (world: DispatcherWorld, channel: string) => world.browserReads.get(channel) ?? 0;

withDispatcher('job:create', (world) => {
  it('records the requester, a fresh id, no retries yet and a budget by type', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('creation');

    const detectionId = await creator.created('comment-annotation', {}, resourceIdOf());
    const detection = await worker.claimed(['comment-annotation']);
    expect(detection.metadata).toMatchObject({ id: detectionId, userId: creator.did, retryCount: 0, maxRetries: 1 });
    expect(Date.parse(detection.metadata.created)).not.toBeNaN();

    const generationId = await creator.created('generation', generation(resourceIdOf()));
    const generated = await worker.claimed(['generation']);
    expect(generated.metadata).toMatchObject({ id: generationId, userId: creator.did, retryCount: 0, maxRetries: 0 });
    expect(generationId).not.toBe(detectionId);

    expect((await creator.statusOf(detectionId)).userId).toBe(creator.did);
    expect((await world().assigned(generationId)).payload['requester']).toBe(creator.did);
  });

  it('refuses a job of any type but generation that names no resource, and queues nothing', async () => {
    const creator = await world().person('creator');
    for (const jobType of ['highlight-annotation', 'reference-annotation'] as const) {
      const answer = await creator.create(jobType, {});
      expect(answer.channel).toBe('job:create-failed');
      expect(answer.payload['message']).toBe(`${jobType} job:create requires resourceId`);
    }
    expect((await (await world().worker('idle')).claim([])).payload['code']).toBe('none-pending');
  });

  it('records a generation job under the resource its context focuses', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('generator');
    const resourceId = resourceIdOf();

    const jobId = await creator.created('generation', generation(resourceId));
    expect((await world().announced(jobId)).payload['resourceId']).toBe(resourceId);
    const job = await worker.claimed(['generation']);
    expect(job.params.resourceId).toBe(resourceId);
    expect((await world().assigned(jobId)).payload['resourceId']).toBe(resourceId);
  });

  it('records a generation job focused on an annotation under the resource the annotation is on', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('generator');
    const sourceResource = resourceIdOf();
    const params = generation('unused', {
      context: { focus: { kind: 'annotation', annotation: { id: `ann-${randomUUID()}` }, sourceResource: { '@id': sourceResource, name: 'The source' } } },
    });

    await creator.created('generation', params);
    expect((await worker.claimed(['generation'])).params.resourceId).toBe(sourceResource);
  });

  it.each([
    ['a resourceId beside the context', { resourceId: 'res-caller' }, {}, 'generation job:create must omit resourceId — the context\'s focus is authoritative'],
    ['a params.referenceId', {}, { referenceId: 'ref-caller' }, 'generation job:create must omit params.referenceId — the context\'s focus is authoritative'],
    ['params without a storageUri', {}, { storageUri: '' }, 'generation params do not satisfy GenerationJobParams (title, storageUri, and context are required)'],
    ['params without a title', {}, { title: undefined }, 'generation params do not satisfy GenerationJobParams (title, storageUri, and context are required)'],
    ['a context with no usable focus', {}, { context: { focus: { kind: 'nothing' } } }, 'generation context has no usable focus — pass a GatheredContext produced by gather.resource(...) or gather.annotation(...)'],
  ])('refuses a generation job with %s, and queues nothing', async (_what, envelope, change, message) => {
    const creator = await world().person('creator');
    const params = JSON.parse(JSON.stringify({ ...generation(resourceIdOf()), ...change })) as Record<string, unknown>;
    const answer = await creator.request('job:create', { jobType: 'generation', params, ...envelope });
    expect(answer.channel).toBe('job:create-failed');
    expect(answer.payload['message']).toBe(message);
    expect((await (await world().worker('idle')).claim(['generation'])).payload['code']).toBe('none-pending');
  });

  it('refuses a params.resourceId for every type: the job\'s resource is never the caller\'s to override', async () => {
    const creator = await world().person('creator');
    const message = 'job:create must omit params.resourceId — the job\'s resource is its resourceId, or a generation\'s context focus';
    const detection = await creator.create('highlight-annotation', { resourceId: 'res-caller' }, resourceIdOf());
    expect(detection.channel).toBe('job:create-failed');
    expect(detection.payload['message']).toBe(message);
    const generated = await creator.create('generation', generation(resourceIdOf(), { resourceId: 'res-caller' }));
    expect(generated.channel).toBe('job:create-failed');
    expect(generated.payload['message']).toBe(message);
    expect((await (await world().worker('idle')).claim([])).payload['code']).toBe('none-pending');
  });

  it('admits entity types the knowledge base registers, reading them afresh for every job', async () => {
    const creator = await world().person('creator');
    const before = reads(world(), ENTITY_TYPES);
    await creator.created('reference-annotation', { entityTypes: VOCABULARY.entityTypes }, resourceIdOf());
    await creator.created('generation', generation(resourceIdOf(), { entityTypes: ['Person'] }));
    expect(reads(world(), ENTITY_TYPES)).toBe(before + 2);
  });

  it('refuses entity types the knowledge base does not register, naming every one, and queues nothing', async () => {
    const creator = await world().person('creator');
    const reference = await creator.create('reference-annotation', { entityTypes: ['Person', 'Unicorn', 'Dragon'] }, resourceIdOf());
    expect(reference.channel).toBe('job:create-failed');
    expect(reference.payload['message']).toBe('Entity type not registered: Unicorn, Dragon');
    expect(reference.payload['code']).toBeUndefined();

    const generated = await creator.create('generation', generation(resourceIdOf(), { entityTypes: ['UnknownThing'] }));
    expect(generated.payload['message']).toBe('Entity type not registered: UnknownThing');
    expect((await (await world().worker('idle')).claim([])).payload['code']).toBe('none-pending');
  });

  it('does not read the entity types when there are none to check', async () => {
    const creator = await world().person('creator');
    const before = reads(world(), ENTITY_TYPES);
    await creator.created('reference-annotation', {}, resourceIdOf());
    await creator.created('reference-annotation', { entityTypes: [] }, resourceIdOf());
    await creator.created('generation', generation(resourceIdOf()));
    // Only reference-annotation and generation are checked: another type's entityTypes are its own.
    await creator.created('highlight-annotation', { entityTypes: ['Unicorn'] }, resourceIdOf());
    expect(reads(world(), ENTITY_TYPES)).toBe(before);
  });

  it('resolves a tag-annotation\'s schemaId into the schema itself, so its worker needs no registry', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('tagger');
    const resourceId = resourceIdOf();
    await creator.created('tag-annotation', { schemaId: 'irac', categories: ['Issue'], language: 'en' }, resourceId);
    const job = await worker.claimed(['tag-annotation']);
    expect(job.params).toEqual({ resourceId, schema: VOCABULARY.tagSchemas[0], categories: ['Issue'], language: 'en' });
  });

  it('refuses a tag-annotation whose schemaId is missing or not registered, reading the schemas either way', async () => {
    const creator = await world().person('creator');
    const before = reads(world(), TAG_SCHEMAS);
    const missing = await creator.create('tag-annotation', { categories: ['Issue'] }, resourceIdOf());
    expect(missing.payload['message']).toBe('tag-annotation requires schemaId');
    const unknown = await creator.create('tag-annotation', { schemaId: 'nope', categories: ['Issue'] }, resourceIdOf());
    expect(unknown.payload['message']).toBe('Tag schema not registered: nope');
    expect(reads(world(), TAG_SCHEMAS)).toBe(before + 2);
    expect((await (await world().worker('idle')).claim(['tag-annotation'])).payload['code']).toBe('none-pending');
  });

  it('leaves every other type\'s params as given, without reading the tag schemas', async () => {
    const creator = await world().person('creator');
    const worker = await world().worker('assessor');
    const before = reads(world(), TAG_SCHEMAS);
    const resourceId = resourceIdOf();
    const params = { instructions: 'be kind', tone: 'constructive', density: 2, schemaId: 'irac' };
    await creator.created('assessment-annotation', params, resourceId);
    expect((await worker.claimed(['assessment-annotation'])).params).toEqual({ resourceId, ...params });
    expect(reads(world(), TAG_SCHEMAS)).toBe(before);
  });
});

withDispatcher('job:create with the Archivist absent', (world) => {
  it('refuses at once a job that needs a vocabulary read, naming the read and carrying peer-unavailable', async () => {
    const creator = await world().person('creator');
    for (const [jobType, params, read] of [
      ['reference-annotation', { entityTypes: ['Person'] }, ENTITY_TYPES],
      ['tag-annotation', { schemaId: 'irac', categories: ['Issue'] }, TAG_SCHEMAS],
    ] as const) {
      const started = Date.now();
      const answer = await creator.create(jobType, params, resourceIdOf());
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
    await creator.created('highlight-annotation', {}, resourceIdOf());
    await creator.created('reference-annotation', {}, resourceIdOf());
  });
}, { vocabulary: null });
