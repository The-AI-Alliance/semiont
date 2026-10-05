/**
 * The files the record keeps are read by other processes, and after the
 * Archivist's port by another language. Each has a schema in the spec; this
 * holds what the TypeScript writes to it, and the event log's own shard
 * formatting to the shared table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { EventBus, getShardPath, resourceId, userId, annotationId, type Annotation } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';
import { SemiontProject } from '@semiont/core/node';
import { createHash } from 'crypto';
import { createEventStore } from '../event-store-factory';
import type { EventStore } from '../event-store';

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/archivist/shard-cases.json');
const { cases }: { cases: { why: string; key: string; shard: string }[] } = JSON.parse(readFileSync(TABLE, 'utf8'));

describe('the files the record keeps', () => {
  let testDir: string;
  let project: SemiontProject;
  let store: EventStore;
  let xdgBefore: string | undefined;
  const RESOURCE = resourceId('res-formats-1');
  const PERSON = userId('did:web:kb.example:users:ada');
  const URI = 'file://docs/formats.md';

  const read = async (...parts: string[]): Promise<unknown> =>
    JSON.parse(await fs.readFile(join(project.stateDir, ...parts), 'utf8'));
  const expectValid = (schema: keyof typeof validators, document: unknown) => {
    const validate = validators[schema];
    expect(validate(document), `${schema}: ${formatErrors(validate.errors)}`).toBe(true);
  };

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-record-formats-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    xdgBefore = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(testDir, 'state');
    project = new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` });
    store = createEventStore(project, new EventBus());

    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: annotationId('ann-formats-1'),
      motivation: 'highlighting',
      target: { source: RESOURCE, selector: { type: 'TextQuoteSelector', exact: 'formats' } },
      created: '2026-01-01T00:00:00.000Z',
    };
    await store.appendEvent({
      type: 'yield:created', resourceId: RESOURCE, userId: PERSON, version: 1,
      payload: { name: 'Formats', format: 'text/markdown', contentChecksum: 'c'.repeat(64), contentByteSize: 7, storageUri: URI, entityTypes: ['Document'] },
    });
    await store.appendEvent({ type: 'mark:added', resourceId: RESOURCE, userId: PERSON, version: 1, payload: { annotation } });
    await store.appendEvent({ type: 'frame:entity-type-added', userId: PERSON, version: 1, payload: { entityType: 'Document' } });
    await store.appendEvent({
      type: 'frame:tag-schema-added', userId: PERSON, version: 1,
      payload: { schema: { id: 'argument', name: 'Argument', description: 'Claims and grounds', domain: 'general', tags: [] } },
    });
    await store.appendEvent({ type: 'person:profiled', userId: PERSON, version: 1, payload: { name: 'Ada' } });
  });

  afterAll(async () => {
    if (xdgBefore === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = xdgBefore;
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('the view is a ResourceView, filed by the shard of its resource id', async () => {
    const view = await read('resources', ...getShardPath(RESOURCE), `${RESOURCE}.json`);
    expectValid('ResourceView', view);
    expect(view).toMatchObject({ lastSequence: 2, annotations: { version: 2 } });
  });

  it('the vocabulary and the people are their projections', async () => {
    expectValid('EntityTypesProjection', await read('projections', '__system__', 'entitytypes.json'));
    expectValid('TagSchemasProjection', await read('projections', '__system__', 'tagschemas.json'));
    const people = await read('projections', '__system__', 'people.json');
    expectValid('PeopleProjection', people);
    expect(people).toMatchObject({ people: { [PERSON]: { name: 'Ada' } } });
  });

  it('the storage-uri entry is a StorageUriEntry, filed by the shard and the SHA-256 of its URI', async () => {
    const entry = await read('projections', 'storage-uri', ...getShardPath(URI), `${createHash('sha256').update(URI).digest('hex')}.json`);
    expectValid('StorageUriEntry', entry);
    expect(entry).toEqual({ uri: URI, resourceId: RESOURCE });
  });

  it('a stored event is a line of the log: the event as given, then its id, timestamp and sequence number', async () => {
    const [ab, cd] = getShardPath(RESOURCE);
    const lines = (await fs.readFile(join(project.eventsDir, ab, cd, RESOURCE, 'events-000001.jsonl'), 'utf8')).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    const first = JSON.parse(lines[0]!);
    expect(Object.keys(first)).toEqual(['type', 'resourceId', 'userId', 'version', 'payload', 'id', 'timestamp', 'metadata']);
    expect(first.metadata).toEqual({ sequenceNumber: 1 });
    expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.parse(lines[1]!).metadata).toEqual({ sequenceNumber: 2 });
  });

  it('the event log files a stream where the shared table says', () => {
    const ids = cases.filter(({ key }) => /^[A-Za-z0-9_-]{1,128}$/.test(key));
    expect(ids.length).toBeGreaterThan(0);
    for (const { key, shard } of ids) {
      expect(store.log.storage.getShardPath(resourceId(key)), key).toBe(shard);
    }
  });
});
