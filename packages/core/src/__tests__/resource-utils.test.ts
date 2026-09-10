import { describe, test, expect } from 'vitest';
import type { components } from '../types';
import { resourceId } from '../identifiers';
import {
  getResourceId,
  getPrimaryRepresentation,
  getPrimaryMediaType,
  getChecksum,
  getLanguage,
  getStorageUri,
  getCreator,
  getDerivedFrom,
  isArchived,
  getResourceEntityTypes,
  isDraft,
  getNodeEncoding,
  decodeRepresentation,
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

describe('getChecksum', () => {
  test('returns checksum from primary representation', () => {
    const r = makeResource({ representations: makeRep({ checksum: 'sha256:abc' }) });
    expect(getChecksum(r)).toBe('sha256:abc');
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

describe('getCreator', () => {
  test('returns single agent', () => {
    const agent = { '@type': 'Person' as const, '@id': 'user:1', name: 'Alice' };
    const r = makeResource({ wasAttributedTo: agent });
    expect(getCreator(r)).toEqual(agent);
  });

  test('returns first from array', () => {
    const agents = [
      { '@type': 'Person' as const, '@id': 'user:1', name: 'Alice' },
      { '@type': 'Software' as const, '@id': 'bot:1', name: 'Bot' },
    ];
    const r = makeResource({ wasAttributedTo: agents });
    expect(getCreator(r)?.name).toBe('Alice');
  });

  test('returns undefined when no creator', () => {
    expect(getCreator(makeResource())).toBeUndefined();
  });
});

describe('getDerivedFrom', () => {
  test('returns single URI', () => {
    const r = makeResource({ wasDerivedFrom: 'http://example.com/source' });
    expect(getDerivedFrom(r)).toBe('http://example.com/source');
  });

  test('returns first from array', () => {
    const r = makeResource({ wasDerivedFrom: ['http://a.com', 'http://b.com'] });
    expect(getDerivedFrom(r)).toBe('http://a.com');
  });

  test('returns undefined when not set', () => {
    expect(getDerivedFrom(makeResource())).toBeUndefined();
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

describe('getNodeEncoding', () => {
  test('maps utf-8', () => {
    expect(getNodeEncoding('UTF-8')).toBe('utf8');
  });

  test('maps iso-8859-1 to latin1', () => {
    expect(getNodeEncoding('ISO-8859-1')).toBe('latin1');
  });

  test('maps windows-1252 to latin1', () => {
    expect(getNodeEncoding('Windows-1252')).toBe('latin1');
  });

  test('maps ascii', () => {
    expect(getNodeEncoding('US-ASCII')).toBe('ascii');
  });

  test('defaults to utf8 for unknown', () => {
    expect(getNodeEncoding('unknown-charset')).toBe('utf8');
  });
});

describe('decodeRepresentation', () => {
  test('decodes utf-8 buffer', () => {
    const buf = Buffer.from('Hello', 'utf8');
    expect(decodeRepresentation(buf, 'text/plain; charset=utf-8')).toBe('Hello');
  });

  test('decodes latin1 buffer', () => {
    const buf = Buffer.from([0xFC]); // ü in latin1
    expect(decodeRepresentation(buf, 'text/plain; charset=iso-8859-1')).toBe('ü');
  });

  test('defaults to utf-8 when no charset', () => {
    const buf = Buffer.from('Test', 'utf8');
    expect(decodeRepresentation(buf, 'text/plain')).toBe('Test');
  });
});

// The chokepoint gate (bugs/gather-ships-raw-pdf-bytes-to-inference-as-a-title
// P1): decoding is only legitimate for media whose text SOURCE is 'decode'.
// Binary media reaching this function used to yield megabytes of mojibake;
// now it throws, so no caller — present or future — can decode bytes that
// were never text. This gate supersedes a caller census: it cannot drift.
describe('decodeRepresentation refuses non-decode media', () => {
  test('throws on binary media instead of returning mojibake', () => {
    const buf = Buffer.from('%PDF-1.4 not text', 'utf8');
    expect(() => decodeRepresentation(buf, 'application/pdf')).toThrow(/pdf-text-layer|decode/);
  });

  test('throws on unregistered binary media (textSource none)', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(() => decodeRepresentation(buf, 'application/x-unknown-binary')).toThrow();
  });

  test('still decodes registered text media', () => {
    expect(decodeRepresentation(Buffer.from('{"a":1}', 'utf8'), 'application/json')).toBe('{"a":1}');
  });

  test('still decodes unregistered text/* subtypes (RFC 2046 fallback)', () => {
    expect(decodeRepresentation(Buffer.from('x', 'utf8'), 'text/x-anything')).toBe('x');
  });
});
