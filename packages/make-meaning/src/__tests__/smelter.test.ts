/**
 * Smelter Tests
 *
 * Tests the Smelter actor's event processing pipeline:
 * - Resource embedding and indexing (via embedBatch)
 * - Annotation embedding and indexing
 * - Deletion handling
 * - embedding:computed events emitted on EventBus (for Stower persistence)
 * - rebuildAll() replay from event log
 * - Cross-resource batch processing
 *
 * Uses MemoryVectorStore and a mock EmbeddingProvider.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, resourceId, userId, CREATION_METHODS } from '@semiont/core';
import type { Logger, EventMap } from '@semiont/core';
import { MemoryVectorStore } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import { WorkingTreeStore } from '@semiont/content';
import { Smelter } from '../smelter';
import { partitionByType } from '../batch-utils';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const tick = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function deterministicEmbed(text: string): number[] {
  const vec = new Array(4);
  for (let i = 0; i < 4; i++) {
    vec[i] = Math.sin((text.charCodeAt(i % text.length) || 0) + i);
  }
  return vec;
}

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => deterministicEmbed(text)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(deterministicEmbed)),
    dimensions: vi.fn().mockReturnValue(4),
    model: vi.fn().mockReturnValue('mock-model'),
  };
}

describe('partitionByType', () => {
  it('partitions consecutive same-type events into runs', () => {
    const events = [
      { event: { type: 'a' } },
      { event: { type: 'a' } },
      { event: { type: 'b' } },
      { event: { type: 'b' } },
      { event: { type: 'b' } },
      { event: { type: 'a' } },
    ] as any;

    const runs = partitionByType(events);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toHaveLength(2);
    expect(runs[1]).toHaveLength(3);
    expect(runs[2]).toHaveLength(1);
  });

  it('returns single run for uniform events', () => {
    const events = [
      { event: { type: 'x' } },
      { event: { type: 'x' } },
    ] as any;

    const runs = partitionByType(events);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(partitionByType([])).toEqual([]);
  });
});

describe('Smelter', () => {
  let tempDir: string;
  let project: SemiontProject;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let vectorStore: MemoryVectorStore;
  let embeddingProvider: EmbeddingProvider;
  let contentStore: WorkingTreeStore;
  let smelter: Smelter;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `smelter-test-${uuidv4()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(join(tempDir, '.semiont'), { recursive: true });
    await fs.writeFile(join(tempDir, '.semiont', 'config'), '[project]\nname = "test"\n');

    project = new SemiontProject(tempDir);
    await fs.mkdir(project.eventsDir, { recursive: true });
    await fs.mkdir(project.projectionsDir, { recursive: true });
    await fs.mkdir(project.representationsDir, { recursive: true });
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    const viewStorage = new FilesystemViewStorage(project);
    eventStore = new EventStore(project, project.projectionsDir, viewStorage, eventBus, mockLogger);
    vectorStore = new MemoryVectorStore();
    await vectorStore.connect();
    embeddingProvider = createMockEmbeddingProvider();
    contentStore = new WorkingTreeStore(project, mockLogger);

    smelter = new Smelter(
      eventStore,
      eventBus,
      vectorStore,
      embeddingProvider,
      contentStore,
      mockLogger,
    );
    await smelter.initialize();
  });

  afterEach(async () => {
    await smelter.stop();
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initializes without error', () => {
    expect(smelter).toBeDefined();
  });

  it('calls embedBatch when a resource is created with content', async () => {
    const content = Buffer.from('Abraham Lincoln was the 16th president of the United States.');
    const uri = 'file://lincoln.txt';
    await contentStore.store(content, uri, { noGit: true });

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('res-lincoln'),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'Lincoln',
        format: 'text/plain',
        contentChecksum: 'abc123',
        creationMethod: CREATION_METHODS.UPLOAD,
        storageUri: uri,
      },
    });

    await tick();

    expect(embeddingProvider.embedBatch).toHaveBeenCalled();
  });

  it('emits embedding:computed events on the EventBus', async () => {
    const content = Buffer.from('Short text for embedding test.');
    const uri = 'file://embed-test.txt';
    await contentStore.store(content, uri, { noGit: true });

    const received: EventMap['embedding:computed'][] = [];
    eventBus.get('embedding:computed').subscribe(e => received.push(e));

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('res-embed'),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'Embed Test',
        format: 'text/plain',
        contentChecksum: 'def456',
        creationMethod: CREATION_METHODS.UPLOAD,
        storageUri: uri,
      },
    });

    await tick();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].resourceId).toBe('res-embed');
    expect(received[0].chunkIndex).toBe(0);
    expect(received[0].embedding).toHaveLength(4);
    expect(received[0].model).toBe('mock-model');
    expect(received[0].dimensions).toBe(4);
  });

  it('indexes resource vectors into vector store', async () => {
    const content = Buffer.from('The quick brown fox jumps over the lazy dog.');
    const uri = 'file://fox.txt';
    await contentStore.store(content, uri, { noGit: true });

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('res-fox'),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'Fox',
        format: 'text/plain',
        contentChecksum: 'fox123',
        creationMethod: CREATION_METHODS.UPLOAD,
        storageUri: uri,
      },
    });

    await tick();

    const queryVec = deterministicEmbed('quick brown fox');
    const results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('indexes annotation text into vector store', async () => {
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('res-1'),
      userId: userId('user-1'),
      version: 1,
      payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
    });
    await tick();

    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: resourceId('res-1'),
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: 'ann-1',
          motivation: 'highlighting',
          target: {
            type: 'SpecificResource',
            source: 'res-1',
            selector: {
              type: 'TextQuoteSelector',
              exact: 'Lincoln was a great leader',
            },
          },
          body: [],
          created: new Date().toISOString(),
        },
      },
    } as any);

    await tick();

    expect(embeddingProvider.embed).toHaveBeenCalledWith('Lincoln was a great leader');
    const queryVec = deterministicEmbed('Lincoln was a great leader');
    const results = await vectorStore.searchAnnotations(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('deletes resource vectors on resource.archived', async () => {
    const content = Buffer.from('Content to be archived.');
    const uri = 'file://archive-me.txt';
    await contentStore.store(content, uri, { noGit: true });

    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('res-archive'),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: 'Archive Me',
        format: 'text/plain',
        contentChecksum: 'arch1',
        creationMethod: CREATION_METHODS.UPLOAD,
        storageUri: uri,
      },
    });
    await tick();

    // Verify indexed
    const queryVec = deterministicEmbed('Content to be archived');
    let results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    // Archive
    await eventStore.appendEvent({
      type: 'resource.archived',
      resourceId: resourceId('res-archive'),
      userId: userId('user-1'),
      version: 1,
      payload: {},
    });
    await tick();

    // Verify deleted
    results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBe(0);
  });

  it('rebuilds vector store from event log via rebuildAll', async () => {
    const rid = resourceId('res-rebuild');
    const text = 'Rebuilding vectors from event log.';
    const embedding = deterministicEmbed(text);

    // Simulate what the Stower would persist: an embedding.computed event
    await eventStore.appendEvent({
      type: 'embedding.computed',
      resourceId: rid,
      userId: userId('did:web:system:smelter'),
      version: 1,
      payload: {
        chunkIndex: 0,
        chunkText: text,
        embedding,
        model: 'mock-model',
        dimensions: 4,
      },
    });

    // Vector store is empty — nothing indexed yet
    const queryVec = deterministicEmbed(text);
    let results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBe(0);

    // Rebuild from event log
    await smelter.rebuildAll();

    results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].resourceId).toBe(String(rid));
  });

  it('stops cleanly', async () => {
    await smelter.stop();
    // No errors thrown
  });
});
