/**
 * Backup Exporter Tests
 *
 * Tests full backup export to tar.gz archive.
 * Verifies manifest structure, event stream inclusion,
 * content blob collection, and archive layout.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { Logger, ResourceId, StoredEvent, UserId } from '@semiont/core';

function bufferToReadable(buf: Buffer): Readable {
  const stream = new Readable({ read() {} });
  stream.push(buf);
  stream.push(null);
  return stream;
}
import { exportBackup } from '../../exchange/backup-exporter';
import { readTarGz } from '../../exchange/tar';
import { BACKUP_FORMAT, FORMAT_VERSION } from '../../exchange/manifest';

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

function makeStoredEvent(type: string, payload: Record<string, unknown>, checksum: string): StoredEvent {
  return {
    event: {
      id: 'evt-1',
      type,
      resourceId: 'resource-1' as ResourceId,
      userId: 'did:web:localhost:users:test' as UserId,
      timestamp: '2026-03-12T00:00:00Z',
      version: 1,
      payload,
    },
    metadata: {
      sequenceNumber: 1,
      streamPosition: 0,
      timestamp: '2026-03-12T00:00:00Z',
      checksum,
      prevEventHash: undefined,
    },
  } as StoredEvent;
}

function createMockEventStore(opts: {
  resourceIds?: ResourceId[];
  systemEvents?: StoredEvent[];
  resourceEvents?: Map<string, StoredEvent[]>;
}) {
  const { resourceIds = [], systemEvents = [], resourceEvents = new Map() } = opts;

  return {
    log: {
      storage: {
        getAllResourceIds: vi.fn().mockResolvedValue(resourceIds),
      },
      getEvents: vi.fn().mockImplementation(async (id: ResourceId) => {
        if (id === '__system__') return systemEvents;
        return resourceEvents.get(id) ?? [];
      }),
    },
  };
}

function createMockContentStore(blobs: Map<string, Buffer>) {
  return {
    retrieve: vi.fn().mockImplementation(async (checksum: string) => {
      const data = blobs.get(checksum);
      if (!data) throw new Error(`Content not found: ${checksum}`);
      return data;
    }),
  };
}

describe('backup-exporter', () => {
  it('exports an empty knowledge base', async () => {
    const eventStore = createMockEventStore({});
    const contentStore = createMockContentStore(new Map());
    const { writable, promise } = collectWritable();

    const manifest = await exportBackup(
      { eventStore, content: contentStore, sourceUrl: 'http://localhost:8080', logger: mockLogger },
      writable,
    );

    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.version).toBe(FORMAT_VERSION);
    expect(manifest.stats.streams).toBe(0);
    expect(manifest.stats.events).toBe(0);
    expect(manifest.stats.blobs).toBe(0);

    // Parse the archive — should contain only .semiont/manifest.jsonl
    const archive = await promise;
    const entries: Array<{ name: string }> = [];
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entries.push(entry);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('.semiont/manifest.jsonl');
  });

  it('exports system events and resource events', async () => {
    const systemEvents = [
      makeStoredEvent('mark:entity-type-added', { entityType: 'Person' }, 'sys-check-1'),
    ];
    const resourceId = 'res-abc' as ResourceId;
    const resourceEvents = new Map<string, StoredEvent[]>();
    resourceEvents.set(resourceId, [
      makeStoredEvent('yield:created', {
        name: 'Test Doc',
        storageUri: 'sha-content',
        format: 'text/markdown',
        language: 'en',
        entityTypes: ['Person'],
        creationMethod: 'api',
      }, 'res-check-1'),
    ]);

    const contentBlobs = new Map([
      ['sha-content', Buffer.from('# Test Content\n', 'utf8')],
    ]);

    const eventStore = createMockEventStore({
      resourceIds: [resourceId],
      systemEvents,
      resourceEvents,
    });
    const contentStore = createMockContentStore(contentBlobs);
    const { writable, promise } = collectWritable();

    const manifest = await exportBackup(
      { eventStore, content: contentStore, sourceUrl: 'http://localhost:8080', logger: mockLogger },
      writable,
    );

    expect(manifest.stats.streams).toBe(2); // __system__ + 1 resource
    expect(manifest.stats.events).toBe(2); // 1 system + 1 resource
    expect(manifest.stats.blobs).toBe(1);
    expect(manifest.stats.contentBytes).toBe(Buffer.from('# Test Content\n').length);

    // Parse the archive
    const archive = await promise;
    const entryNames: string[] = [];
    const entryDataMap = new Map<string, Buffer>();
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entryNames.push(entry.name);
      entryDataMap.set(entry.name, entry.data);
    }

    expect(entryNames).toContain('.semiont/manifest.jsonl');
    expect(entryNames).toContain('.semiont/events/__system__.jsonl');
    expect(entryNames).toContain(`.semiont/events/${resourceId}.jsonl`);
    expect(entryNames).toContain('sha-content.md');

    // Verify manifest JSONL
    const manifestData = entryDataMap.get('.semiont/manifest.jsonl')!.toString('utf8');
    const manifestLines = manifestData.trim().split('\n');
    expect(manifestLines).toHaveLength(3); // header + 2 stream summaries

    const header = JSON.parse(manifestLines[0]);
    expect(header.format).toBe(BACKUP_FORMAT);
    expect(header.stats.streams).toBe(2);

    // Verify event stream content
    const systemData = entryDataMap.get('.semiont/events/__system__.jsonl')!.toString('utf8');
    const parsedSysEvents = systemData.trim().split('\n').map((l) => JSON.parse(l));
    expect(parsedSysEvents).toHaveLength(1);
    expect(parsedSysEvents[0].event.type).toBe('mark:entity-type-added');

    // Verify content blob
    const contentData = entryDataMap.get('sha-content.md')!;
    expect(contentData.toString('utf8')).toBe('# Test Content\n');
  });

  it('includes correct stream summaries with checksums', async () => {
    const systemEvents = [
      makeStoredEvent('mark:entity-type-added', { entityType: 'A' }, 'first-sys'),
      makeStoredEvent('mark:entity-type-added', { entityType: 'B' }, 'last-sys'),
    ];

    const eventStore = createMockEventStore({ systemEvents });
    const contentStore = createMockContentStore(new Map());
    const { writable, promise } = collectWritable();

    await exportBackup(
      { eventStore, content: contentStore, sourceUrl: 'http://test' },
      writable,
    );

    const archive = await promise;
    let manifestData = '';
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      if (entry.name === '.semiont/manifest.jsonl') {
        manifestData = entry.data.toString('utf8');
      }
    }

    const lines = manifestData.trim().split('\n');
    const streamSummary = JSON.parse(lines[1]);

    expect(streamSummary.stream).toBe('__system__');
    expect(streamSummary.eventCount).toBe(2);
    expect(streamSummary.firstChecksum).toBe('first-sys');
    expect(streamSummary.lastChecksum).toBe('last-sys');
  });

  it('sets sourceUrl and exportedAt in manifest', async () => {
    const eventStore = createMockEventStore({});
    const contentStore = createMockContentStore(new Map());
    const { writable } = collectWritable();

    const manifest = await exportBackup(
      { eventStore, content: contentStore, sourceUrl: 'https://kb.example.com' },
      writable,
    );

    expect(manifest.sourceUrl).toBe('https://kb.example.com');
    expect(manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
