/**
 * Snapshot Importer Tests
 *
 * Tests snapshot import from both plain JSONL and tar.gz formats.
 * Covers:
 * - JSONL auto-detection and parsing
 * - tar.gz auto-detection (gzip magic bytes)
 * - Entity type creation
 * - Resource creation with content
 * - Annotation creation
 * - Binary content resolution from tar
 * - Error handling (wrong format, missing content)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';

function bufferToReadable(buf: Buffer): Readable {
  const stream = new Readable({ read() {} });
  stream.push(buf);
  stream.push(null);
  return stream;
}
import type { Logger, ResourceId, UserId, AnnotationId } from '@semiont/core';
import type { components } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { importSnapshot } from '../../exchange/snapshot-importer';
import { writeTarGz, type TarEntry } from '../../exchange/tar';
import { SNAPSHOT_FORMAT, type SnapshotResource } from '../../exchange/manifest';

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

async function buildTarGz(entries: TarEntry[]): Promise<Buffer> {
  const { writable, promise } = collectWritable();
  async function* gen(): AsyncIterable<TarEntry> {
    for (const e of entries) yield e;
  }
  await writeTarGz(gen(), writable);
  return promise;
}

function makeManifestLine(entityTypes: string[] = [], resourceCount = 0) {
  return JSON.stringify({
    format: SNAPSHOT_FORMAT,
    version: 1,
    exportedAt: '2026-03-12T00:00:00Z',
    sourceUrl: 'http://localhost:8080',
    entityTypes,
    stats: { resources: resourceCount },
  });
}

function makeResourceLine(opts: {
  id: string;
  name: string;
  format?: string;
  text?: string;
  checksum?: string;
  path?: string;
  annotations?: unknown[];
}): string {
  const resource: SnapshotResource = {
    id: opts.id,
    name: opts.name,
    format: opts.format || 'text/markdown',
    language: 'en',
    creationMethod: 'api',
    entityTypes: [],
    dateCreated: '2026-03-12T00:00:00Z',
    archived: false,
    content: {
      checksum: opts.checksum || 'sha-test',
      byteSize: opts.text ? Buffer.from(opts.text).length : 100,
      text: opts.text,
      path: opts.path,
    },
    annotations: opts.annotations || [],
  };
  return JSON.stringify(resource);
}

function defer(fn: () => void): void {
  queueMicrotask(fn);
}

describe('snapshot-importer', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventBus.destroy();
  });

  describe('plain JSONL', () => {
    it('imports an empty snapshot', async () => {
      const jsonl = makeManifestLine([], 0) + '\n';
      const input = bufferToReadable(Buffer.from(jsonl));

      const result = await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(result.manifest.format).toBe(SNAPSHOT_FORMAT);
      expect(result.resourcesCreated).toBe(0);
      expect(result.annotationsCreated).toBe(0);
      expect(result.entityTypesAdded).toBe(0);
    });

    it('imports entity types', async () => {
      eventBus.get('mark:add-entity-type').subscribe((msg) => {
        defer(() => eventBus.get('mark:entity-type-added').next({ tag: msg.tag }));
      });

      const jsonl = makeManifestLine(['Person', 'Location'], 0) + '\n';
      const input = bufferToReadable(Buffer.from(jsonl));

      const result = await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(result.entityTypesAdded).toBe(2);
    });

    it('imports a text resource with inline content', async () => {
      eventBus.get('yield:create').subscribe((msg) => {
        expect(msg.name).toBe('Test Doc');
        expect(msg.content.toString('utf8')).toBe('# Hello');
        expect(msg.format).toBe('text/markdown');
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      const lines = [
        makeManifestLine([], 1),
        makeResourceLine({ id: 'r1', name: 'Test Doc', text: '# Hello' }),
      ].join('\n') + '\n';

      const input = bufferToReadable(Buffer.from(lines));
      const result = await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(result.resourcesCreated).toBe(1);
    });

    it('imports annotations on a resource', async () => {
      eventBus.get('yield:create').subscribe(() => {
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      eventBus.get('mark:create').subscribe((msg) => {
        expect(msg.annotation.id).toBe('ann-1');
        defer(() => eventBus.get('mark:created').next({ annotationId: 'ann-1' as AnnotationId }));
      });

      const annotations = [{
        id: 'ann-1',
        type: 'Annotation',
        motivation: 'commenting',
        body: { type: 'TextualBody', value: 'test comment' },
        target: { source: 'http://example.com' },
      }];

      const lines = [
        makeManifestLine([], 1),
        makeResourceLine({
          id: 'r1',
          name: 'Annotated Doc',
          text: 'content',
          annotations,
        }),
      ].join('\n') + '\n';

      const input = bufferToReadable(Buffer.from(lines));
      const result = await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(result.resourcesCreated).toBe(1);
      expect(result.annotationsCreated).toBe(1);
    });

    it('imports multiple resources', async () => {
      eventBus.get('yield:create').subscribe(() => {
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      const lines = [
        makeManifestLine([], 3),
        makeResourceLine({ id: 'r1', name: 'Doc 1', text: 'aaa' }),
        makeResourceLine({ id: 'r2', name: 'Doc 2', text: 'bbb' }),
        makeResourceLine({ id: 'r3', name: 'Doc 3', text: 'ccc' }),
      ].join('\n') + '\n';

      const input = bufferToReadable(Buffer.from(lines));
      const result = await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(result.resourcesCreated).toBe(3);
    });
  });

  describe('tar.gz format', () => {
    it('auto-detects gzip and imports from tar.gz', async () => {
      eventBus.get('yield:create').subscribe((msg) => {
        expect(msg.name).toBe('Tar Doc');
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      const snapshotJsonl = [
        makeManifestLine([], 1),
        makeResourceLine({ id: 'r1', name: 'Tar Doc', text: 'tar content' }),
      ].join('\n') + '\n';

      const archive = await buildTarGz([
        { name: 'snapshot.jsonl', data: Buffer.from(snapshotJsonl) },
      ]);

      const input = bufferToReadable(archive);
      const result = await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(result.resourcesCreated).toBe(1);
    });

    it('resolves binary content from tar entries', async () => {
      let receivedContent: Buffer | undefined;
      eventBus.get('yield:create').subscribe((msg) => {
        receivedContent = msg.content;
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      const binaryContent = Buffer.from([0x25, 0x50, 0x44, 0x46]);
      const snapshotJsonl = [
        makeManifestLine([], 1),
        makeResourceLine({
          id: 'r1',
          name: 'PDF Doc',
          format: 'application/pdf',
          checksum: 'sha-pdf',
          path: 'sha-pdf.pdf',
        }),
      ].join('\n') + '\n';

      const archive = await buildTarGz([
        { name: 'snapshot.jsonl', data: Buffer.from(snapshotJsonl) },
        { name: 'sha-pdf.pdf', data: binaryContent },
      ]);

      const input = bufferToReadable(archive);
      await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(receivedContent).toBeDefined();
      expect(Buffer.compare(receivedContent!, binaryContent)).toBe(0);
    });

    it('throws on missing binary content in tar', async () => {
      const snapshotJsonl = [
        makeManifestLine([], 1),
        makeResourceLine({
          id: 'r1',
          name: 'Missing Content',
          format: 'application/pdf',
          checksum: 'sha-missing',
          path: 'sha-missing.pdf',
        }),
      ].join('\n') + '\n';

      const archive = await buildTarGz([
        { name: 'snapshot.jsonl', data: Buffer.from(snapshotJsonl) },
        // No content entry!
      ]);

      const input = bufferToReadable(archive);
      await expect(
        importSnapshot(input, { eventBus, userId: TEST_USER, logger: mockLogger })
      ).rejects.toThrow(/Missing binary content/);
    });
  });

  describe('error handling', () => {
    it('rejects wrong format', async () => {
      const badJsonl = JSON.stringify({
        format: 'wrong-format',
        version: 1,
        exportedAt: '2026-03-12T00:00:00Z',
        sourceUrl: 'http://test',
        entityTypes: [],
        stats: { resources: 0 },
      }) + '\n';

      const input = bufferToReadable(Buffer.from(badJsonl));
      await expect(
        importSnapshot(input, { eventBus, userId: TEST_USER })
      ).rejects.toThrow(/expected format/);
    });

    it('rejects unsupported version', async () => {
      const futureJsonl = JSON.stringify({
        format: SNAPSHOT_FORMAT,
        version: 999,
        exportedAt: '2026-03-12T00:00:00Z',
        sourceUrl: 'http://test',
        entityTypes: [],
        stats: { resources: 0 },
      }) + '\n';

      const input = bufferToReadable(Buffer.from(futureJsonl));
      await expect(
        importSnapshot(input, { eventBus, userId: TEST_USER })
      ).rejects.toThrow(/Unsupported format version/);
    });

    it('rejects tar.gz missing snapshot.jsonl', async () => {
      const archive = await buildTarGz([
        { name: 'wrong.txt', data: Buffer.from('nope') },
      ]);

      const input = bufferToReadable(archive);
      await expect(
        importSnapshot(input, { eventBus, userId: TEST_USER })
      ).rejects.toThrow(/missing snapshot\.jsonl/);
    });
  });

  describe('entity type + resource ordering', () => {
    it('creates entity types before resources', async () => {
      const order: string[] = [];

      eventBus.get('mark:add-entity-type').subscribe(() => {
        order.push('entity-type');
        defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'Person' }));
      });

      eventBus.get('yield:create').subscribe(() => {
        order.push('resource');
        defer(() => eventBus.get('yield:created').next({
          resourceId: TEST_RESOURCE,
          resource: STUB_RESOURCE,
        }));
      });

      const lines = [
        makeManifestLine(['Person'], 1),
        makeResourceLine({ id: 'r1', name: 'Doc', text: 'content' }),
      ].join('\n') + '\n';

      const input = bufferToReadable(Buffer.from(lines));
      await importSnapshot(input, {
        eventBus,
        userId: TEST_USER,
        logger: mockLogger,
      });

      expect(order).toEqual(['entity-type', 'resource']);
    });
  });
});
