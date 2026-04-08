/**
 * Backup Importer Tests
 *
 * Tests backup import from tar.gz archives through EventBus replay.
 * Covers manifest validation, blob resolution, system event replay,
 * resource event replay, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { Logger, ResourceId, UserId } from '@semiont/core';
import type { components } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { importBackup } from '../../exchange/backup-importer';
import { writeTarGz, type TarEntry } from '../../exchange/tar';
import { BACKUP_FORMAT } from '../../exchange/manifest';

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

function makeManifest(opts: { streams?: number; events?: number; blobs?: number } = {}) {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: '2026-03-12T00:00:00Z',
    sourceUrl: 'http://localhost:8080',
    stats: {
      streams: opts.streams ?? 1,
      events: opts.events ?? 1,
      blobs: opts.blobs ?? 0,
      contentBytes: 0,
    },
  });
}

function makeStreamSummary(stream: string, eventCount: number) {
  return JSON.stringify({ stream, eventCount, firstChecksum: 'fc', lastChecksum: 'lc' });
}

function makeStoredEventJson(type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    event: { type, resourceId: TEST_RESOURCE, userId: TEST_USER, payload },
    metadata: {
      sequenceNumber: 1,
      streamPosition: 0,
      timestamp: '2026-03-12T00:00:00Z',
      checksum: 'abc123',
      prevEventHash: null,
    },
  });
}

function defer(fn: () => void): void {
  queueMicrotask(fn);
}

describe('backup-importer', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventBus.destroy();
  });

  it('imports a backup with system events', async () => {
    // Wire up handler for entity type addition
    eventBus.get('mark:add-entity-type').subscribe(() => {
      defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'Person' } as any));
    });

    const manifestLines = [
      makeManifest({ streams: 1, events: 1 }),
      makeStreamSummary('__system__', 1),
    ].join('\n') + '\n';

    const systemEvents = makeStoredEventJson('mark:entity-type-added', { entityType: 'Person' }) + '\n';

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(manifestLines) },
      { name: '.semiont/events/__system__.jsonl', data: Buffer.from(systemEvents) },
    ]);

    const result = await importBackup(bufferToReadable(archive), { eventBus, logger: mockLogger });

    expect(result.manifest.format).toBe(BACKUP_FORMAT);
    expect(result.stats.eventsReplayed).toBe(1);
    expect(result.stats.entityTypesAdded).toBe(1);
    expect(result.hashChainValid).toBe(true);
  });

  it('imports a backup with resource events and content blobs', async () => {
    const contentBlob = Buffer.from('# Hello World', 'utf8');

    // Wire up handlers
    eventBus.get('yield:create').subscribe((msg) => {
      expect(msg.name).toBe('Test Doc');
      expect(msg.content!.toString('utf8')).toBe('# Hello World');
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const manifestLines = [
      makeManifest({ streams: 1, events: 1, blobs: 1 }),
      makeStreamSummary(TEST_RESOURCE, 1),
    ].join('\n') + '\n';

    const resourceEvents = makeStoredEventJson('yield:created', {
      name: 'Test Doc',
      contentChecksum: 'sha-content',
      format: 'text/markdown',
      language: 'en',
      entityTypes: [],
      creationMethod: 'api',
    }) + '\n';

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(manifestLines) },
      { name: `.semiont/events/${TEST_RESOURCE}.jsonl`, data: Buffer.from(resourceEvents) },
      { name: 'sha-content.md', data: contentBlob },
    ]);

    const result = await importBackup(bufferToReadable(archive), { eventBus, logger: mockLogger });

    expect(result.stats.eventsReplayed).toBe(1);
    expect(result.stats.resourcesCreated).toBe(1);
    expect(result.hashChainValid).toBe(true);
  });

  it('resolves content blobs by checksum from entry names', async () => {
    let receivedContent: Buffer | undefined;
    eventBus.get('yield:create').subscribe((msg) => {
      receivedContent = msg.content;
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const manifestLines = [
      makeManifest({ streams: 1, events: 1, blobs: 1 }),
      makeStreamSummary(TEST_RESOURCE, 1),
    ].join('\n') + '\n';

    const resourceEvents = makeStoredEventJson('yield:created', {
      name: 'Binary Doc',
      contentChecksum: 'deadbeef1234',
      format: 'application/pdf',
    }) + '\n';

    const pdfContent = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(manifestLines) },
      { name: `.semiont/events/${TEST_RESOURCE}.jsonl`, data: Buffer.from(resourceEvents) },
      { name: 'deadbeef1234.pdf', data: pdfContent },
    ]);

    await importBackup(bufferToReadable(archive), { eventBus, logger: mockLogger });

    expect(receivedContent).toBeDefined();
    expect(Buffer.compare(receivedContent!, pdfContent)).toBe(0);
  });

  it('rejects an archive without manifest.jsonl', async () => {
    const archive = await buildArchive([
      { name: 'some-other-file.txt', data: Buffer.from('nope') },
    ]);

    await expect(
      importBackup(bufferToReadable(archive), { eventBus })
    ).rejects.toThrow(/missing \.semiont\/manifest\.jsonl/);
  });

  it('rejects an archive with wrong format', async () => {
    const badManifest = JSON.stringify({
      format: 'wrong-format',
      version: 1,
      exportedAt: '2026-03-12T00:00:00Z',
      sourceUrl: 'http://test',
      stats: { streams: 0, events: 0, blobs: 0, contentBytes: 0 },
    }) + '\n';

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(badManifest) },
    ]);

    await expect(
      importBackup(bufferToReadable(archive), { eventBus })
    ).rejects.toThrow(/expected format/);
  });

  it('rejects an archive with unsupported version', async () => {
    const futureManifest = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 999,
      exportedAt: '2026-03-12T00:00:00Z',
      sourceUrl: 'http://test',
      stats: { streams: 0, events: 0, blobs: 0, contentBytes: 0 },
    }) + '\n';

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(futureManifest) },
    ]);

    await expect(
      importBackup(bufferToReadable(archive), { eventBus })
    ).rejects.toThrow(/Unsupported format version/);
  });

  it('warns on missing event stream files', async () => {
    const manifestLines = [
      makeManifest({ streams: 1, events: 1 }),
      makeStreamSummary('missing-resource', 1),
    ].join('\n') + '\n';

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(manifestLines) },
      // Note: no .semiont/events/missing-resource.jsonl
    ]);

    const result = await importBackup(bufferToReadable(archive), { eventBus, logger: mockLogger });

    // Should complete without error, but skip the missing stream
    expect(result.stats.eventsReplayed).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('imports system events before resource events (order matters)', async () => {
    const order: string[] = [];

    eventBus.get('mark:add-entity-type').subscribe(() => {
      order.push('entity-type');
      defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'Person' } as any));
    });

    eventBus.get('yield:create').subscribe(() => {
      order.push('resource-created');
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const manifestLines = [
      makeManifest({ streams: 2, events: 2, blobs: 1 }),
      makeStreamSummary('__system__', 1),
      makeStreamSummary(TEST_RESOURCE, 1),
    ].join('\n') + '\n';

    const systemEvents = makeStoredEventJson('mark:entity-type-added', { entityType: 'Person' }) + '\n';
    const resourceEvents = makeStoredEventJson('yield:created', {
      name: 'Doc',
      contentChecksum: 'chk1',
      format: 'text/markdown',
    }) + '\n';

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(manifestLines) },
      { name: '.semiont/events/__system__.jsonl', data: Buffer.from(systemEvents) },
      { name: `.semiont/events/${TEST_RESOURCE}.jsonl`, data: Buffer.from(resourceEvents) },
      { name: 'chk1.md', data: Buffer.from('content') },
    ]);

    await importBackup(bufferToReadable(archive), { eventBus, logger: mockLogger });

    expect(order).toEqual(['entity-type', 'resource-created']);
  });

  it('merges stats across multiple streams', async () => {
    eventBus.get('mark:add-entity-type').subscribe(() => {
      defer(() => eventBus.get('mark:entity-type-added').next({ tag: 'X' } as any));
    });

    eventBus.get('yield:create').subscribe(() => {
      defer(() => eventBus.get('yield:created').next({
        resourceId: TEST_RESOURCE,
        resource: STUB_RESOURCE,
      }));
    });

    const res1 = 'res-1' as ResourceId;
    const res2 = 'res-2' as ResourceId;

    const manifestLines = [
      makeManifest({ streams: 3, events: 4, blobs: 2 }),
      makeStreamSummary('__system__', 2),
      makeStreamSummary(res1, 1),
      makeStreamSummary(res2, 1),
    ].join('\n') + '\n';

    const systemEvents = [
      makeStoredEventJson('mark:entity-type-added', { entityType: 'A' }),
      makeStoredEventJson('mark:entity-type-added', { entityType: 'B' }),
    ].join('\n') + '\n';

    const res1Events = makeStoredEventJson('yield:created', {
      name: 'Doc 1', contentChecksum: 'c1', format: 'text/markdown',
    }) + '\n';

    const res2Events = makeStoredEventJson('yield:created', {
      name: 'Doc 2', contentChecksum: 'c2', format: 'text/markdown',
    }) + '\n';

    const archive = await buildArchive([
      { name: '.semiont/manifest.jsonl', data: Buffer.from(manifestLines) },
      { name: '.semiont/events/__system__.jsonl', data: Buffer.from(systemEvents) },
      { name: `.semiont/events/${res1}.jsonl`, data: Buffer.from(res1Events) },
      { name: `.semiont/events/${res2}.jsonl`, data: Buffer.from(res2Events) },
      { name: 'c1.md', data: Buffer.from('doc 1 content') },
      { name: 'c2.md', data: Buffer.from('doc 2 content') },
    ]);

    const result = await importBackup(bufferToReadable(archive), { eventBus, logger: mockLogger });

    expect(result.stats.eventsReplayed).toBe(4);
    expect(result.stats.entityTypesAdded).toBe(2);
    expect(result.stats.resourcesCreated).toBe(2);
  });
});
