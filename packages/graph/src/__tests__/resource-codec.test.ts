/**
 * The resource codec: which properties a resource row has in the graph, what
 * each is called, and what is refused. Pure, so every case runs with no store.
 */
import { describe, it, expect } from 'vitest';
import { resourceId } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import { decodeResource, type StoredResourceProperties } from '../resource-codec';

const ASKER = { '@type': 'Person' as const, '@id': 'did:web:example.org:users:ada', name: 'Ada' };
const WORKER = { '@type': 'Software' as const, '@id': 'did:web:example.org:agents:anthropic:model', name: 'model' };

/** A resource as the Weaver's fold builds one from a `yield:created`. */
const FOLDED: ResourceDescriptor = {
  '@context': 'https://schema.org/',
  '@id': resourceId('res-1'),
  name: 'Cedar County, Iowa',
  entityTypes: ['Place', 'County'],
  representations: [
    { mediaType: 'text/markdown', checksum: 'sha256:abc', rel: 'original', storageUri: 'file:///kb/cedar.md' },
  ],
  archived: false,
  dateCreated: '2020-03-04T05:06:07.000Z',
  wasAttributedTo: [ASKER, WORKER],
};

const STORED: StoredResourceProperties = {
  id: 'res-1',
  name: 'Cedar County, Iowa',
  entityTypes: ['Place', 'County'],
  format: 'text/markdown',
  archived: false,
  created: '2020-03-04T05:06:07.000Z',
  creator: JSON.stringify([ASKER, WORKER]),
  contentChecksum: 'sha256:abc',
  storageUri: 'file:///kb/cedar.md',
};

describe('decodeResource', () => {
  it('rebuilds the resource the fold gave, representation and all', () => {
    expect(decodeResource(STORED)).toEqual(FOLDED);
  });

  it('puts no storage URI on the representation when the row has none', () => {
    const { storageUri: _none, ...withoutUri } = STORED;
    const [representation] = decodeResource(withoutUri).representations as Array<Record<string, unknown>>;
    expect('storageUri' in representation!).toBe(false);
  });

  it('reads a false archived flag and an empty tag list as values, not as absence', () => {
    expect(decodeResource({ ...STORED, archived: false, entityTypes: [] })).toMatchObject({
      archived: false,
      entityTypes: [],
    });
  });

  it.each(['id', 'name', 'entityTypes', 'format', 'archived', 'created', 'creator', 'contentChecksum'] as const)(
    'refuses a row with no %s, by that name',
    (key) => {
      const { [key]: _missing, ...row } = STORED;
      expect(() => decodeResource(row)).toThrow(`missing required field: ${key}`);
      expect(() => decodeResource({ ...STORED, [key]: null })).toThrow(`missing required field: ${key}`);
    },
  );
});
