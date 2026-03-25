/**
 * Linked Data Exporter Tests
 *
 * Tests JSON-LD export to tar.gz archive.
 * Verifies manifest structure, per-resource JSON-LD documents,
 * content blob collection, and archive layout.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { Logger } from '@semiont/core';
import type { components } from '@semiont/core';
import { exportLinkedData } from '../../exchange/linked-data-exporter';
import { readTarGz } from '../../exchange/tar';
import { LINKED_DATA_FORMAT, FORMAT_VERSION } from '../../exchange/manifest';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

function bufferToReadable(buf: Buffer): Readable {
  const stream = new Readable({ read() {} });
  stream.push(buf);
  stream.push(null);
  return stream;
}

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function collectWritable(): { writable: Writable; promise: Promise<Buffer> } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const promise = new Promise<Buffer>((resolve, reject) => {
    writable.on('finish', () => resolve(Buffer.concat(chunks)));
    writable.on('error', reject);
  });
  return { writable, promise };
}

function makeResource(overrides: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return {
    '@context': 'https://schema.org',
    '@id': 'res-abc',
    name: 'Test Document',
    storageUri: 'deadbeef1234',
    representations: [{
      mediaType: 'text/markdown',
      byteSize: 15,
      checksum: 'sha256:deadbeef1234',
      language: 'en',
    }],
    dateCreated: '2026-03-12T00:00:00Z',
    entityTypes: ['Person'],
    creationMethod: 'ui',
    ...overrides,
  };
}

function makeAnnotation(id: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id,
    motivation: 'commenting',
    body: {
      type: 'TextualBody',
      value: 'A test annotation',
      format: 'text/plain',
    },
    target: {
      source: 'res-abc',
      selector: { type: 'TextQuoteSelector', exact: 'test' },
    },
    creator: {
      '@id': 'did:web:test:users:alice',
      '@type': 'Person',
      name: 'Alice',
    },
  } as Annotation;
}

function createMockViews(resources: Array<{ resource: ResourceDescriptor; annotations: Annotation[] }>) {
  return {
    getAll: vi.fn().mockResolvedValue(
      resources.map((r) => ({
        resource: r.resource,
        annotations: { annotations: r.annotations },
      })),
    ),
  };
}

function createMockContent(blobs: Map<string, Buffer>) {
  return {
    retrieve: vi.fn().mockImplementation(async (checksum: string) => {
      const data = blobs.get(checksum);
      if (!data) throw new Error(`Content not found: ${checksum}`);
      return data;
    }),
  };
}

describe('linked-data-exporter', () => {
  it('exports an empty knowledge base', async () => {
    const views = createMockViews([]);
    const content = createMockContent(new Map());
    const { writable, promise } = collectWritable();

    const manifest = await exportLinkedData(
      { views, content, sourceUrl: 'http://localhost:4000', entityTypes: [], logger: mockLogger },
      writable,
    );

    expect(manifest['semiont:format']).toBe(LINKED_DATA_FORMAT);
    expect(manifest['semiont:version']).toBe(FORMAT_VERSION);
    expect(manifest['void:entities']).toBe(0);

    const archive = await promise;
    const entries: Array<{ name: string }> = [];
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('.semiont/manifest.jsonld');
  });

  it('exports resources with JSON-LD documents and content blobs', async () => {
    const resource = makeResource();
    const annotation = makeAnnotation('ann-1');
    const views = createMockViews([{ resource, annotations: [annotation] }]);
    const content = createMockContent(new Map([
      ['deadbeef1234', Buffer.from('# Test Content\n', 'utf8')],
    ]));
    const { writable, promise } = collectWritable();

    const manifest = await exportLinkedData(
      {
        views,
        content,
        sourceUrl: 'http://localhost:4000',
        entityTypes: ['Person'],
        logger: mockLogger,
      },
      writable,
    );

    expect(manifest['void:entities']).toBe(1);
    expect(manifest['semiont:entityTypes']).toEqual(['Person']);

    const archive = await promise;
    const entryMap = new Map<string, Buffer>();
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entryMap.set(entry.name, entry.data);
    }

    expect(entryMap.has('.semiont/manifest.jsonld')).toBe(true);
    expect(entryMap.has('.semiont/resources/res-abc.jsonld')).toBe(true);
    expect(entryMap.has('deadbeef1234.md')).toBe(true);

    // Verify resource JSON-LD structure
    const resourceDoc = JSON.parse(entryMap.get('.semiont/resources/res-abc.jsonld')!.toString('utf8'));
    expect(resourceDoc['@id']).toBe('http://localhost:4000/resources/res-abc');
    expect(resourceDoc['name']).toBe('Test Document');
    expect(resourceDoc['inLanguage']).toBe('en');
    expect(resourceDoc['encodingFormat']).toBe('text/markdown');
    expect(resourceDoc['entityTypes']).toEqual(['Person']);
    expect(resourceDoc['creationMethod']).toBe('ui');
    expect(resourceDoc['annotations']).toHaveLength(1);
    expect(resourceDoc['annotations'][0]['id']).toBe('http://localhost:4000/annotations/ann-1');

    // Verify representations
    expect(resourceDoc['representations']).toHaveLength(1);
    expect(resourceDoc['representations'][0]['sha256']).toBe('deadbeef1234');
    expect(resourceDoc['representations'][0]['encodingFormat']).toBe('text/markdown');
  });

  it('strips sha256: prefix from checksums', async () => {
    const resource = makeResource({
      storageUri: 'abcdef',
      representations: [{
        mediaType: 'application/pdf',
        byteSize: 100,
        checksum: 'sha256:abcdef',
        language: 'en',
      }],
    });
    const views = createMockViews([{ resource, annotations: [] }]);
    const content = createMockContent(new Map([
      ['abcdef', Buffer.from('%PDF')],
    ]));
    const { writable, promise } = collectWritable();

    await exportLinkedData(
      { views, content, sourceUrl: 'http://test', entityTypes: [], logger: mockLogger },
      writable,
    );

    const archive = await promise;
    const entryNames: string[] = [];
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entryNames.push(entry.name);
    }

    expect(entryNames).toContain('abcdef.pdf');
    expect(entryNames).not.toContain('sha256:abcdef.pdf');
  });

  it('filters out archived resources by default', async () => {
    const active = makeResource({ '@id': 'active', archived: false });
    const archived = makeResource({ '@id': 'archived', archived: true });
    const views = createMockViews([
      { resource: active, annotations: [] },
      { resource: archived, annotations: [] },
    ]);
    const content = createMockContent(new Map([
      ['deadbeef1234', Buffer.from('content')],
    ]));
    const { writable, promise } = collectWritable();

    const manifest = await exportLinkedData(
      { views, content, sourceUrl: 'http://test', entityTypes: [] },
      writable,
    );

    expect(manifest['void:entities']).toBe(1);

    const archive = await promise;
    const entryNames: string[] = [];
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entryNames.push(entry.name);
    }

    expect(entryNames).toContain('.semiont/resources/active.jsonld');
    expect(entryNames).not.toContain('.semiont/resources/archived.jsonld');
  });

  it('includes archived resources when includeArchived is true', async () => {
    const archived = makeResource({ '@id': 'archived', archived: true });
    const views = createMockViews([{ resource: archived, annotations: [] }]);
    const content = createMockContent(new Map([
      ['deadbeef1234', Buffer.from('content')],
    ]));
    const { writable, promise } = collectWritable();

    const manifest = await exportLinkedData(
      { views, content, sourceUrl: 'http://test', entityTypes: [], includeArchived: true },
      writable,
    );

    expect(manifest['void:entities']).toBe(1);

    const archive = await promise;
    const entryNames: string[] = [];
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entryNames.push(entry.name);
    }

    expect(entryNames).toContain('.semiont/resources/archived.jsonld');
  });

  it('sets provenance in manifest', async () => {
    const views = createMockViews([]);
    const content = createMockContent(new Map());
    const { writable } = collectWritable();

    const manifest = await exportLinkedData(
      { views, content, sourceUrl: 'https://kb.example.com', entityTypes: ['Person', 'Location'] },
      writable,
    );

    expect(manifest['prov:wasGeneratedBy']['prov:used']).toBe('https://kb.example.com');
    expect(manifest['semiont:entityTypes']).toEqual(['Person', 'Location']);
    expect(manifest['dct:created']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('warns and continues when a content blob cannot be retrieved', async () => {
    const resource = makeResource();
    const views = createMockViews([{ resource, annotations: [] }]);
    const content = createMockContent(new Map()); // empty — no blobs available
    const { writable } = collectWritable();

    const manifest = await exportLinkedData(
      { views, content, sourceUrl: 'http://test', entityTypes: [], logger: mockLogger },
      writable,
    );

    expect(manifest['void:entities']).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
