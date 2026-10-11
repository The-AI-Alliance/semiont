/**
 * The resource codec: which properties a resource has in the graph, what each
 * is called, and what is refused. Pure, so every case runs with no store.
 */
import { describe, it, expect } from 'vitest';
import { resourceId } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import { decodeResource, encodeResource, type StoredResourceProperties } from '../resource-codec';

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

describe('encodeResource', () => {
  it('names every stored property, once, for every store', () => {
    expect(encodeResource(FOLDED)).toEqual(STORED);
  });

  it('stores the recorded date and attribution as given: a string, and both parties', () => {
    const props = encodeResource(FOLDED);
    expect(props.created).toBe(FOLDED.dateCreated);
    expect(JSON.parse(props.creator)).toEqual([ASKER, WORKER]);
  });

  it('writes no storage URI property at all when the representation has none', () => {
    const props = encodeResource({
      ...FOLDED,
      representations: [{ mediaType: 'text/markdown', checksum: 'sha256:abc', rel: 'original' }],
    });
    expect('storageUri' in props).toBe(false);
  });

  it('reads a resource with no archived flag as not archived, and one with no entity types as having none', () => {
    const { archived: _a, entityTypes: _e, ...sparse } = FOLDED;
    expect(encodeResource(sparse)).toMatchObject({ archived: false, entityTypes: [] });
  });

  it.each([
    ['@id', { ...FOLDED, '@id': undefined }],
    ['representations', { ...FOLDED, representations: [] }],
    ['name', { ...FOLDED, name: '' }],
    ['dateCreated', { ...FOLDED, dateCreated: undefined }],
    ['wasAttributedTo', { ...FOLDED, wasAttributedTo: undefined }],
    ['representations.checksum', { ...FOLDED, representations: [{ mediaType: 'text/markdown', rel: 'original' as const }] }],
  ])('refuses a resource with no %s, by that name, rather than storing a row it could not read back', (field, resource) => {
    expect(() => encodeResource(resource as ResourceDescriptor)).toThrow(`missing required field: ${field}`);
  });
});

describe('decodeResource', () => {
  it('rebuilds the resource the fold gave, representation and all', () => {
    expect(decodeResource(STORED)).toEqual(FOLDED);
  });

  it('round-trips: what is read is what was written', () => {
    expect(decodeResource(encodeResource(FOLDED))).toEqual(FOLDED);
    expect(encodeResource(decodeResource(STORED))).toEqual(STORED);
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

  it('keeps of a resource only what the graph holds', () => {
    const fromAView: ResourceDescriptor = {
      ...FOLDED,
      description: 'A county',
      dateModified: '2026-01-01T00:00:00.000Z',
      isDraft: true,
      representations: [{ ...(FOLDED.representations as Array<Record<string, unknown>>)[0]!, mediaType: 'text/markdown', byteSize: 12 }],
    };
    expect(decodeResource(encodeResource(fromAView))).toEqual(FOLDED);
  });
});
