/**
 * The record as the Archivist leaves it, written directly: view files, the
 * people projection, and a stand-in for its content endpoint. Readers under
 * test read these the way they read a deployed knowledge base's.
 *
 * Every file is checked against its schema before it is written, so a
 * fixture cannot hold a shape the Archivist would never keep.
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { SYSTEM_SCOPE, getPrimaryRepresentation, getShardPath, resourceId, type Annotation, type ResourceId, type components } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';
import { FilesystemViewStorage, type ResourceView } from '@semiont/event-sourcing';
import { RepresentationMissing, calculateChecksum, type ContentReads } from '@semiont/content';

type PeopleProjection = components['schemas']['PeopleProjection'];

function assertValid(schema: 'ResourceView' | 'PeopleProjection', document: unknown): void {
  const validate = validators[schema];
  if (!validate(document)) throw new Error(`fixture is not a ${schema}: ${formatErrors(validate.errors)}`);
}

/** Write a resource's view file under `resourcesDir`. */
export async function writeView(resourcesDir: string, view: ResourceView): Promise<void> {
  assertValid('ResourceView', view);
  const id = view.resource['@id'];
  const [ab, cd] = getShardPath(id);
  const file = join(resourcesDir, ab, cd, `${id}.json`);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(view, null, 2), 'utf-8');
}

/** Write the people projection under `stateDir`. */
export async function writePeople(stateDir: string, people: PeopleProjection['people']): Promise<void> {
  const projection: PeopleProjection = { people };
  assertValid('PeopleProjection', projection);
  const file = join(stateDir, 'projections', SYSTEM_SCOPE, 'people.json');
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(projection, null, 2), 'utf-8');
}

export interface ResourceFixture {
  name: string;
  /** The resource's bytes. Without them the view carries no storageUri. */
  text?: string;
  mediaType?: string;
  entityTypes?: string[];
}

export interface RecordFixture {
  stateDir: string;
  resourcesDir: string;
  views: FilesystemViewStorage;
  /** Answers as the Archivist's content endpoint does, from the bytes `resource` was given. */
  content: ContentReads;
  /** Keep a view for a resource, at sequence 1 with no annotations. */
  resource(id: string, fixture: ResourceFixture): Promise<ResourceView>;
  /** Add annotations to a resource's view, one sequence each. */
  annotate(id: string, ...annotations: Annotation[]): Promise<ResourceView>;
  teardown(): Promise<void>;
}

const AT = '2026-01-01T00:00:00.000Z';

export async function createRecordFixture(): Promise<RecordFixture> {
  const stateDir = join(tmpdir(), `semiont-record-fixture-${randomUUID()}`);
  const resourcesDir = join(stateDir, 'resources');
  await fs.mkdir(resourcesDir, { recursive: true });

  const views = new FilesystemViewStorage({ resourcesDir });
  const bytes = new Map<string, Buffer>();

  return {
    stateDir,
    resourcesDir,
    views,
    content: {
      async getBinary(id: ResourceId) {
        const view = await views.get(id);
        if (!view) throw new RepresentationMissing(String(id), 'resource');
        const primary = getPrimaryRepresentation(view.resource);
        const stored = bytes.get(String(id));
        if (!primary?.storageUri || !stored) throw new RepresentationMissing(String(id), 'representation');
        const data = new ArrayBuffer(stored.byteLength);
        new Uint8Array(data).set(stored);
        return { data, contentType: primary.mediaType };
      },
    },
    async resource(id, { name, text, mediaType = 'text/plain', entityTypes = [] }) {
      const rid = resourceId(id);
      const stored = text === undefined ? undefined : Buffer.from(text, 'utf-8');
      if (stored) bytes.set(id, stored);
      const view: ResourceView = {
        resource: {
          '@context': 'https://schema.org/',
          '@id': rid,
          name,
          representations: [{
            mediaType,
            rel: 'original',
            ...(stored ? { checksum: calculateChecksum(stored), byteSize: stored.byteLength, storageUri: `file://fixtures/${id}` } : {}),
          }],
          archived: false,
          entityTypes,
          dateCreated: AT,
        },
        annotations: { resourceId: rid, annotations: [], version: 1, updatedAt: AT },
        lastSequence: 1,
      };
      await writeView(resourcesDir, view);
      return view;
    },
    async annotate(id, ...annotations) {
      const kept = await views.get(resourceId(id));
      if (!kept) throw new Error(`fixture has no view for ${id}`);
      const view: ResourceView = {
        resource: kept.resource,
        annotations: {
          ...kept.annotations,
          annotations: [...kept.annotations.annotations, ...annotations],
          version: kept.annotations.version + annotations.length,
        },
        lastSequence: kept.lastSequence + annotations.length,
      };
      await writeView(resourcesDir, view);
      return view;
    },
    async teardown() {
      await fs.rm(stateDir, { recursive: true, force: true });
    },
  };
}
