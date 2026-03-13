/**
 * Snapshot Exporter Tests
 *
 * Tests current-state snapshot export. Covers:
 * - Plain JSONL output (text-only content)
 * - tar.gz output (binary content)
 * - Resource filtering (archived vs non-archived)
 * - Manifest structure and entity types
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { Logger, ResourceId } from '@semiont/core';
import type { ResourceView } from '@semiont/event-sourcing';

function bufferToReadable(buf: Buffer): Readable {
  const stream = new Readable({ read() {} });
  stream.push(buf);
  stream.push(null);
  return stream;
}
import { exportSnapshot } from '../../exchange/snapshot-exporter';
import { readTarGz } from '../../exchange/tar';
import { SNAPSHOT_FORMAT, FORMAT_VERSION, type SnapshotResource } from '../../exchange/manifest';

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

function makeResourceView(opts: {
  id: string;
  name: string;
  mediaType: string;
  checksum: string;
  archived?: boolean;
  entityTypes?: string[];
}): ResourceView {
  return {
    resource: {
      '@context': 'https://schema.org',
      '@id': `http://localhost:8080/api/resources/${opts.id}`,
      name: opts.name,
      entityTypes: opts.entityTypes || [],
      representations: [
        {
          rel: 'original',
          mediaType: opts.mediaType,
          checksum: opts.checksum,
          byteSize: 100,
          language: 'en',
        },
      ],
      archived: opts.archived || false,
      dateCreated: '2026-03-12T00:00:00Z',
      creationMethod: 'api',
    },
    annotations: {
      resourceId: opts.id as ResourceId,
      annotations: [],
      version: 0,
      updatedAt: '2026-03-12T00:00:00Z',
    },
  } as ResourceView;
}

function createMockViewStorage(views: ResourceView[]) {
  return {
    getAll: vi.fn().mockResolvedValue(views),
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

describe('snapshot-exporter', () => {
  it('exports an empty snapshot as JSONL', async () => {
    const views = createMockViewStorage([]);
    const content = createMockContentStore(new Map());
    const { writable, promise } = collectWritable();

    const manifest = await exportSnapshot(
      {
        views,
        content,
        sourceUrl: 'http://localhost:8080',
        entityTypes: [],
        logger: mockLogger,
      },
      writable,
    );

    expect(manifest.format).toBe(SNAPSHOT_FORMAT);
    expect(manifest.version).toBe(FORMAT_VERSION);
    expect(manifest.stats.resources).toBe(0);

    const output = (await promise).toString('utf8');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(1); // just the header
    const header = JSON.parse(lines[0]);
    expect(header.format).toBe(SNAPSHOT_FORMAT);
  });

  it('exports text resources as plain JSONL', async () => {
    const textContent = Buffer.from('# Hello World\n\nSome text here.');
    const views = createMockViewStorage([
      makeResourceView({
        id: 'res-1',
        name: 'Test Doc',
        mediaType: 'text/markdown',
        checksum: 'sha-text',
      }),
    ]);
    const content = createMockContentStore(new Map([['sha-text', textContent]]));
    const { writable, promise } = collectWritable();

    const manifest = await exportSnapshot(
      {
        views,
        content,
        sourceUrl: 'http://localhost:8080',
        entityTypes: ['Person'],
        logger: mockLogger,
      },
      writable,
    );

    expect(manifest.stats.resources).toBe(1);
    expect(manifest.entityTypes).toEqual(['Person']);

    const output = (await promise).toString('utf8');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 resource

    const resource: SnapshotResource = JSON.parse(lines[1]);
    expect(resource.id).toBe('res-1');
    expect(resource.name).toBe('Test Doc');
    expect(resource.format).toBe('text/markdown');
    expect(resource.content.text).toBe('# Hello World\n\nSome text here.');
    expect(resource.content.checksum).toBe('sha-text');
  });

  it('exports binary resources as tar.gz', async () => {
    const binaryContent = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
    const views = createMockViewStorage([
      makeResourceView({
        id: 'res-bin',
        name: 'Binary Doc',
        mediaType: 'application/pdf',
        checksum: 'sha-binary',
      }),
    ]);
    const content = createMockContentStore(new Map([['sha-binary', binaryContent]]));
    const { writable, promise } = collectWritable();

    const manifest = await exportSnapshot(
      {
        views,
        content,
        sourceUrl: 'http://localhost:8080',
        entityTypes: [],
        logger: mockLogger,
      },
      writable,
    );

    expect(manifest.stats.resources).toBe(1);

    // Should be a tar.gz archive
    const archive = await promise;
    expect(archive[0]).toBe(0x1f); // gzip magic
    expect(archive[1]).toBe(0x8b);

    // Parse the archive
    const entryNames: string[] = [];
    const entryDataMap = new Map<string, Buffer>();
    for await (const entry of readTarGz(bufferToReadable(archive))) {
      entryNames.push(entry.name);
      entryDataMap.set(entry.name, entry.data);
    }

    expect(entryNames).toContain('snapshot.jsonl');
    // Content blob should be in the archive
    const contentEntry = entryNames.find((n) => n.startsWith('content/'));
    expect(contentEntry).toBeDefined();

    // Verify the snapshot.jsonl content
    const snapshotData = entryDataMap.get('snapshot.jsonl')!.toString('utf8');
    const lines = snapshotData.trim().split('\n');
    const resource: SnapshotResource = JSON.parse(lines[1]);
    expect(resource.content.path).toBeDefined();
    expect(resource.content.text).toBeUndefined();
  });

  it('filters out archived resources by default', async () => {
    const views = createMockViewStorage([
      makeResourceView({
        id: 'active',
        name: 'Active',
        mediaType: 'text/plain',
        checksum: 'sha-active',
      }),
      makeResourceView({
        id: 'archived',
        name: 'Archived',
        mediaType: 'text/plain',
        checksum: 'sha-archived',
        archived: true,
      }),
    ]);
    const content = createMockContentStore(new Map([
      ['sha-active', Buffer.from('active content')],
      ['sha-archived', Buffer.from('archived content')],
    ]));
    const { writable, promise } = collectWritable();

    const manifest = await exportSnapshot(
      {
        views,
        content,
        sourceUrl: 'http://localhost:8080',
        entityTypes: [],
        logger: mockLogger,
      },
      writable,
    );

    expect(manifest.stats.resources).toBe(1);

    const output = (await promise).toString('utf8');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 resource
    const resource: SnapshotResource = JSON.parse(lines[1]);
    expect(resource.name).toBe('Active');
  });

  it('includes archived resources when includeArchived is true', async () => {
    const views = createMockViewStorage([
      makeResourceView({
        id: 'active',
        name: 'Active',
        mediaType: 'text/plain',
        checksum: 'sha-active',
      }),
      makeResourceView({
        id: 'archived',
        name: 'Archived',
        mediaType: 'text/plain',
        checksum: 'sha-archived',
        archived: true,
      }),
    ]);
    const content = createMockContentStore(new Map([
      ['sha-active', Buffer.from('active content')],
      ['sha-archived', Buffer.from('archived content')],
    ]));
    const { writable, promise } = collectWritable();

    const manifest = await exportSnapshot(
      {
        views,
        content,
        sourceUrl: 'http://localhost:8080',
        entityTypes: [],
        includeArchived: true,
        logger: mockLogger,
      },
      writable,
    );

    expect(manifest.stats.resources).toBe(2);

    const output = (await promise).toString('utf8');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 resources
  });

  it('exports multiple resources with entity types', async () => {
    const views = createMockViewStorage([
      makeResourceView({
        id: 'res-1',
        name: 'Doc 1',
        mediaType: 'text/markdown',
        checksum: 'sha-1',
        entityTypes: ['Person'],
      }),
      makeResourceView({
        id: 'res-2',
        name: 'Doc 2',
        mediaType: 'text/plain',
        checksum: 'sha-2',
        entityTypes: ['Location', 'Organization'],
      }),
    ]);
    const content = createMockContentStore(new Map([
      ['sha-1', Buffer.from('doc 1 text')],
      ['sha-2', Buffer.from('doc 2 text')],
    ]));
    const { writable, promise } = collectWritable();

    const manifest = await exportSnapshot(
      {
        views,
        content,
        sourceUrl: 'http://test',
        entityTypes: ['Person', 'Location', 'Organization'],
        logger: mockLogger,
      },
      writable,
    );

    expect(manifest.stats.resources).toBe(2);
    expect(manifest.entityTypes).toEqual(['Person', 'Location', 'Organization']);

    const output = (await promise).toString('utf8');
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(3);

    const r1: SnapshotResource = JSON.parse(lines[1]);
    const r2: SnapshotResource = JSON.parse(lines[2]);
    expect(r1.entityTypes).toEqual(['Person']);
    expect(r2.entityTypes).toEqual(['Location', 'Organization']);
  });
});
