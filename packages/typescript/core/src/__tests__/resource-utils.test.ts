import { describe, test, expect } from 'vitest';
import type { components } from '../types';
import { resourceId } from '../identifiers';
import {
  getResourceId,
  getPrimaryRepresentation,
  getPrimaryMediaType,
  getLanguage,
  getStorageUri,
  isArchived,
  getResourceEntityTypes,
  isDraft,
} from '../resource-utils';

import type { ResourceDescriptor } from '../graph';
type Representation = components['schemas']['Representation'];

function makeResource(overrides?: Partial<ResourceDescriptor>): ResourceDescriptor {
  return {
    '@context': 'http://schema.org',
    '@id': resourceId('abc-123'),
    name: 'Test',
    representations: [],
    ...overrides,
  };
}

function makeRep(overrides?: Partial<Representation>): Representation {
  return {
    mediaType: 'text/plain',
    ...overrides,
  };
}

describe('getResourceId', () => {
  test('returns bare ID from @id', () => {
    expect(getResourceId(makeResource())).toBe('abc-123');
  });

  test('returns @id as-is', () => {
    expect(getResourceId(makeResource({ '@id': resourceId('xyz-456') }))).toBe('xyz-456');
  });

  test('returns undefined for undefined resource', () => {
    expect(getResourceId(undefined)).toBeUndefined();
  });
});

describe('getPrimaryRepresentation', () => {
  test('returns first from array', () => {
    const rep = makeRep({ mediaType: 'text/markdown' });
    const r = makeResource({ representations: [rep, makeRep()] });
    expect(getPrimaryRepresentation(r)).toEqual(rep);
  });

  test('returns single representation', () => {
    const rep = makeRep({ mediaType: 'image/png' });
    const r = makeResource({ representations: rep });
    expect(getPrimaryRepresentation(r)).toEqual(rep);
  });

  test('returns undefined for undefined resource', () => {
    expect(getPrimaryRepresentation(undefined)).toBeUndefined();
  });
});

describe('getPrimaryMediaType', () => {
  test('returns media type from primary representation', () => {
    const r = makeResource({ representations: makeRep({ mediaType: 'text/markdown' }) });
    expect(getPrimaryMediaType(r)).toBe('text/markdown');
  });

  test('returns undefined for empty representations', () => {
    expect(getPrimaryMediaType(makeResource({ representations: [] }))).toBeUndefined();
  });
});

describe('getLanguage', () => {
  test('returns language from primary representation', () => {
    const r = makeResource({ representations: makeRep({ language: 'en' }) });
    expect(getLanguage(r)).toBe('en');
  });
});

describe('getStorageUri', () => {
  test('returns storageUri from primary representation', () => {
    const r = makeResource({ representations: makeRep({ storageUri: 'file:///data/abc.txt' }) });
    expect(getStorageUri(r)).toBe('file:///data/abc.txt');
  });
});

describe('isArchived', () => {
  test('returns true when archived', () => {
    expect(isArchived(makeResource({ archived: true }))).toBe(true);
  });

  test('returns false when not archived', () => {
    expect(isArchived(makeResource({ archived: false }))).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(isArchived(undefined)).toBe(false);
  });
});

describe('getResourceEntityTypes', () => {
  test('returns entity types', () => {
    expect(getResourceEntityTypes(makeResource({ entityTypes: ['Person', 'Org'] }))).toEqual(['Person', 'Org']);
  });

  test('returns empty array when not set', () => {
    expect(getResourceEntityTypes(makeResource())).toEqual([]);
  });
});

describe('isDraft', () => {
  test('returns true when draft', () => {
    expect(isDraft(makeResource({ isDraft: true }))).toBe(true);
  });

  test('returns false when not draft', () => {
    expect(isDraft(makeResource())).toBe(false);
  });
});
