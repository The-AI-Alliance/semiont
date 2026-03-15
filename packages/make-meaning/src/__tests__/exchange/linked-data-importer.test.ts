/**
 * Linked Data Importer Tests
 *
 * Tests JSON-LD import from tar.gz archives through EventBus.
 * Covers manifest validation, entity type creation, resource creation,
 * annotation creation, blob resolution, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { Logger, ResourceId, UserId, AnnotationId } from '@semiont/core';
import type { components } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { importLinkedData } from '../../exchange/linked-data-importer';
import { writeTarGz, type TarEntry } from '../../exchange/tar';
import { LINKED_DATA_FORMAT } from '../../exchange/manifest';

function bufferToReadable(buf: Buffer): Readable {
  const stream = new Readable({ read() {} });
  stream.push(buf);
  stream.push(null);
  return stream;
}

const TEST_USER = 'did:web:localhost:users:test' as UserId;
const TEST_RESOURCE = 'test-resource-id' as ResourceId;

const STUB_RESOURCE: components['schemas']['ResourceDescriptor'] = {
  '@context': 'https://schema.org',
  '@id': 'http://test/resources/stub',
  name: 'stub',
  representations: [],
};

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

async function buildArchive(entries: TarEntry[]): Promise<Buffer> {
  const { writable, promise } = collectWritable();
  async function* gen(): AsyncIterable<TarEntry> {
    for (const e of entries) yield e;
  }
  await writeTarGz(gen(), writable);
  return promise;
}

function makeManifest(opts: { entityTypes?: string[]; entities?: number } = {}) {
  return JSON.stringify({
    '@context': {
      semiont: 'https://semiont.org/vocab/',
      schema: 'https://schema.org/',
      dct: 'http://purl.org/dc/terms/',
      prov: 'http://www.w3.org/ns/prov#',
      void: 'http://rdfs.org/ns/void#',
    },
    '@type': 'void:Dataset',
    'semiont:format': LINKED_DATA_FORMAT,
    'semiont:version': 1,
    'dct:created': '2026-03-15T00:00:00Z',
    'prov:wasGeneratedBy': {
      '@type': 'prov:Activity',
      'prov:used': 'http://localhost:4000',
    },
    'semiont:entityTypes': opts.entityTypes ?? [],
    'void:entities': opts.entities ?? 0,
  }, null, 2);
}

function makeResourceDoc(opts: {
  name?: string;
  checksum?: string;
  mediaType?: string;
  annotations?: Array<Record<string, unknown>>;
  entityTypes?: string[];
} = {}) {
  return JSON.stringify({
    '@context': [
      'https://schema.org/',
      'http://www.w3.org/ns/anno.jsonld',
      { semiont: 'https://semiont.org/vocab/' },
    ],
    '@id': 'http://localhost:4000/resources/res-abc',
    '@type': 'DigitalDocument',
    name: opts.name ?? 'Test Document',
    dateCreated: '2026-03-12T00:00:00Z',
    inLanguage: 'en',
    encodingFormat: opts.mediaType ?? 'text/markdown',
    creationMethod: 'ui',
    entityTypes: opts.entityTypes ?? [],
    representations: [{
      '@type': 'schema:MediaObject',
      encodingFormat: opts.mediaType ?? 'text/markdown',
      contentSize: 15,
      sha256: opts.checksum ?? 'deadbeef1234',
      name: `${opts.checksum ?? 'deadbeef1234'}.md`,
      inLanguage: 'en',
    }],
    annotations: opts.annotations ?? [],
  }, null, 2);
}

function defer(fn: () => void): void {
  queueMicrotask(fn);
}

describe('linked-data-importer', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventBus.destroy();
  });

  it('imports entity types from manifest', async () => {
    const addedTypes: string[] = [];
    eventBus.get('mark:add-entity-type').subscribe((msg) => {
      addedTypes.push(msg.tag);
      defer(() => eventBus.get('mark:entity-type-added').next({ tag: msg.tag }));
    });

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(makeManifest({ entityTypes: ['Person', 'Location'] })) },
    ]);

    const result = await importLinkedData(bufferToReadable(archive), {
      eventBus,
      userId: TEST_USER,
      logger: mockLogger,
    });

    expect(result.entityTypesAdded).toBe(2);
    expect(addedTypes).toEqual(['Person', 'Location']);
    expect(result.manifest['semiont:format']).toBe(LINKED_DATA_FORMAT);
  });

  it('imports a resource with content blob', async () => {
    eventBus.get('mark:add-entity-type').subscribe((msg) => {
      defer(() => eventBus.get('mark:entity-type-added').next({ tag: msg.tag }));
    });

    let receivedContent: Buffer | undefined;
    eventBus.get('yield:create').subscribe((msg) => {
      receivedContent = msg.content;
      expect(msg.name).toBe('Test Document');
      expect(msg.format).toBe('text/markdown');
      expect(msg.language).toBe('en');
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(makeManifest({ entityTypes: ['Person'], entities: 1 })) },
      { name: '.semiont/resources/res-abc.jsonld', data: Buffer.from(makeResourceDoc({ entityTypes: ['Person'] })) },
      { name: 'deadbeef1234.md', data: Buffer.from('# Test Content\n') },
    ]);

    const result = await importLinkedData(bufferToReadable(archive), {
      eventBus,
      userId: TEST_USER,
      logger: mockLogger,
    });

    expect(result.resourcesCreated).toBe(1);
    expect(result.entityTypesAdded).toBe(1);
    expect(receivedContent).toBeDefined();
    expect(receivedContent!.toString('utf8')).toBe('# Test Content\n');
  });

  it('imports annotations for a resource', async () => {
    eventBus.get('yield:create').subscribe(() => {
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const annotationIds: string[] = [];
    eventBus.get('mark:create').subscribe((msg) => {
      annotationIds.push(msg.annotation.id);
      defer(() => eventBus.get('mark:created').next({
        annotationId: msg.annotation.id as AnnotationId,
      }));
    });

    const annotations = [
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: 'urn:uuid:ann-1',
        motivation: 'commenting',
        body: { type: 'TextualBody', value: 'First', format: 'text/plain' },
        target: { source: 'http://test/resources/res-abc' },
      },
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: 'urn:uuid:ann-2',
        motivation: 'commenting',
        body: { type: 'TextualBody', value: 'Second', format: 'text/plain' },
        target: { source: 'http://test/resources/res-abc' },
      },
    ];

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(makeManifest({ entities: 1 })) },
      { name: '.semiont/resources/res-abc.jsonld', data: Buffer.from(makeResourceDoc({ annotations })) },
      { name: 'deadbeef1234.md', data: Buffer.from('content') },
    ]);

    const result = await importLinkedData(bufferToReadable(archive), {
      eventBus,
      userId: TEST_USER,
      logger: mockLogger,
    });

    expect(result.resourcesCreated).toBe(1);
    expect(result.annotationsCreated).toBe(2);
    expect(annotationIds).toEqual(['urn:uuid:ann-1', 'urn:uuid:ann-2']);
  });

  it('imports multiple resources', async () => {
    const createdNames: string[] = [];
    eventBus.get('yield:create').subscribe((msg) => {
      createdNames.push(msg.name);
      defer(() => eventBus.get('yield:created').next({
        resourceId: `res-${createdNames.length}` as ResourceId,
        resource: STUB_RESOURCE,
      }));
    });

    const doc1 = makeResourceDoc({ name: 'Doc 1', checksum: 'chk1' });
    const doc2 = makeResourceDoc({ name: 'Doc 2', checksum: 'chk2' });

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(makeManifest({ entities: 2 })) },
      { name: '.semiont/resources/res-1.jsonld', data: Buffer.from(doc1) },
      { name: '.semiont/resources/res-2.jsonld', data: Buffer.from(doc2) },
      { name: 'chk1.md', data: Buffer.from('content 1') },
      { name: 'chk2.md', data: Buffer.from('content 2') },
    ]);

    const result = await importLinkedData(bufferToReadable(archive), {
      eventBus,
      userId: TEST_USER,
      logger: mockLogger,
    });

    expect(result.resourcesCreated).toBe(2);
    expect(createdNames).toEqual(['Doc 1', 'Doc 2']);
  });

  it('rejects archive without manifest.jsonld', async () => {
    const archive = await buildArchive([
      { name: 'some-file.txt', data: Buffer.from('nope') },
    ]);

    await expect(
      importLinkedData(bufferToReadable(archive), { eventBus, userId: TEST_USER }),
    ).rejects.toThrow(/missing \.semiont\/manifest\.jsonld/);
  });

  it('rejects archive with wrong format', async () => {
    const badManifest = JSON.stringify({
      '@context': {},
      '@type': 'void:Dataset',
      'semiont:format': 'wrong-format',
      'semiont:version': 1,
      'dct:created': '2026-03-15T00:00:00Z',
      'prov:wasGeneratedBy': { '@type': 'prov:Activity', 'prov:used': 'http://test' },
      'semiont:entityTypes': [],
      'void:entities': 0,
    });

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(badManifest) },
    ]);

    await expect(
      importLinkedData(bufferToReadable(archive), { eventBus, userId: TEST_USER }),
    ).rejects.toThrow(/expected format/);
  });

  it('rejects archive with unsupported version', async () => {
    const futureManifest = JSON.stringify({
      '@context': {},
      '@type': 'void:Dataset',
      'semiont:format': LINKED_DATA_FORMAT,
      'semiont:version': 999,
      'dct:created': '2026-03-15T00:00:00Z',
      'prov:wasGeneratedBy': { '@type': 'prov:Activity', 'prov:used': 'http://test' },
      'semiont:entityTypes': [],
      'void:entities': 0,
    });

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(futureManifest) },
    ]);

    await expect(
      importLinkedData(bufferToReadable(archive), { eventBus, userId: TEST_USER }),
    ).rejects.toThrow(/Unsupported format version/);
  });

  it('throws when content blob is missing for a resource', async () => {
    eventBus.get('yield:create').subscribe(() => {
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(makeManifest({ entities: 1 })) },
      { name: '.semiont/resources/res-abc.jsonld', data: Buffer.from(makeResourceDoc()) },
      // Note: no deadbeef1234.md blob
    ]);

    await expect(
      importLinkedData(bufferToReadable(archive), { eventBus, userId: TEST_USER }),
    ).rejects.toThrow(/Missing content blob/);
  });

  it('uses the provided userId for all events', async () => {
    const customUser = 'did:web:example.com:users:bob' as UserId;

    eventBus.get('mark:add-entity-type').subscribe((msg) => {
      expect(msg.userId).toBe(customUser);
      defer(() => eventBus.get('mark:entity-type-added').next({ tag: msg.tag }));
    });

    eventBus.get('yield:create').subscribe((msg) => {
      expect(msg.userId).toBe(customUser);
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(makeManifest({ entityTypes: ['Person'], entities: 1 })) },
      { name: '.semiont/resources/res-abc.jsonld', data: Buffer.from(makeResourceDoc({ entityTypes: ['Person'] })) },
      { name: 'deadbeef1234.md', data: Buffer.from('content') },
    ]);

    await importLinkedData(bufferToReadable(archive), {
      eventBus,
      userId: customUser,
      logger: mockLogger,
    });
  });

  it('handles PDF content blobs', async () => {
    eventBus.get('yield:create').subscribe((msg) => {
      expect(msg.format).toBe('application/pdf');
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const pdfContent = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonld', data: Buffer.from(makeManifest({ entities: 1 })) },
      {
        name: '.semiont/resources/res-abc.jsonld',
        data: Buffer.from(makeResourceDoc({ checksum: 'pdfhash', mediaType: 'application/pdf' })),
      },
      { name: 'pdfhash.pdf', data: pdfContent },
    ]);

    const result = await importLinkedData(bufferToReadable(archive), {
      eventBus,
      userId: TEST_USER,
      logger: mockLogger,
    });

    expect(result.resourcesCreated).toBe(1);
  });
});
