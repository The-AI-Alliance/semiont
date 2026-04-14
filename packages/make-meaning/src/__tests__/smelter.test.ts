/**
 * Smelter Tests
 *
 * Tests the Smelter actor's event processing pipeline:
 * - Resource embedding and indexing (via embedBatch)
 * - Annotation embedding and indexing
 * - Deletion handling
 * - EmbeddingStore write-through on creation
 * - rebuildAll() loads from EmbeddingStore, detects model mismatch and re-embeds
 * - Cross-resource batch processing
 *
 * Uses MemoryVectorStore and a mock EmbeddingProvider.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { EventStore, FilesystemViewStorage, type ViewStorage } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, resourceId, userId, CREATION_METHODS } from '@semiont/core';
import type { Logger } from '@semiont/core';
import { MemoryVectorStore } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import { WorkingTreeStore } from '@semiont/content';
import { Smelter } from '../smelter';
import { EmbeddingStore } from '../embedding-store';
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

function createMockEmbeddingProvider(model = 'mock-model'): EmbeddingProvider {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => deterministicEmbed(text)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(deterministicEmbed)),
    dimensions: vi.fn().mockReturnValue(4),
    model: vi.fn().mockReturnValue(model),
  };
}

describe('partitionByType', () => {
  it('partitions consecutive same-type events into runs', () => {
    const events = [
      { type: 'a' },
      { type: 'a' },
      { type: 'b' },
      { type: 'b' },
      { type: 'b' },
      { type: 'a' },
    ] as any;

    const runs = partitionByType(events);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toHaveLength(2);
    expect(runs[1]).toHaveLength(3);
    expect(runs[2]).toHaveLength(1);
  });

  it('returns single run for uniform events', () => {
    const events = [
      { type: 'x' },
      { type: 'x' },
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
  let embeddingStore: EmbeddingStore;
  let viewStorage: ViewStorage;
  let smelter: Smelter;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `smelter-test-${uuidv4()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(join(tempDir, '.semiont'), { recursive: true });
    await fs.writeFile(join(tempDir, '.semiont', 'config'), '[project]\nname = "test"\n');

    project = new SemiontProject(tempDir);
    await fs.mkdir(project.eventsDir, { recursive: true });
    await fs.mkdir(project.embeddingsDir, { recursive: true });
    await fs.mkdir(project.projectionsDir, { recursive: true });
    await fs.mkdir(project.representationsDir, { recursive: true });
  });

  beforeEach(async () => {
    eventBus = new EventBus();
    viewStorage = new FilesystemViewStorage(project);
    eventStore = new EventStore(project, project.projectionsDir, viewStorage, eventBus, mockLogger);
    vectorStore = new MemoryVectorStore();
    await vectorStore.connect();
    embeddingProvider = createMockEmbeddingProvider();
    contentStore = new WorkingTreeStore(project, mockLogger);
    embeddingStore = new EmbeddingStore(project);

    smelter = new Smelter(
      eventStore,
      eventBus,
      vectorStore,
      embeddingProvider,
      contentStore,
      embeddingStore,
      viewStorage,
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
      type: 'yield:created',
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

  it('writes embeddings to EmbeddingStore on resource creation', async () => {
    const content = Buffer.from('Short text for embedding test.');
    const uri = 'file://embed-test.txt';
    await contentStore.store(content, uri, { noGit: true });

    const rid = resourceId('res-embed-store');
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: rid,
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

    const stored = await embeddingStore.readResourceEmbeddings(rid);
    expect(stored).not.toBeNull();
    expect(stored!.model).toBe('mock-model');
    expect(stored!.chunks.length).toBeGreaterThan(0);
    expect(stored!.chunks[0].embedding).toHaveLength(4);
  });

  it('indexes resource vectors into vector store', async () => {
    const content = Buffer.from('The quick brown fox jumps over the lazy dog.');
    const uri = 'file://fox.txt';
    await contentStore.store(content, uri, { noGit: true });

    await eventStore.appendEvent({
      type: 'yield:created',
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

  it('indexes annotation text into vector store and EmbeddingStore', async () => {
    await eventStore.appendEvent({
      type: 'yield:created',
      resourceId: resourceId('res-1'),
      userId: userId('user-1'),
      version: 1,
      payload: { name: 'Test', format: 'text/plain', contentChecksum: 'h1', creationMethod: CREATION_METHODS.API },
    });
    await tick();

    await eventStore.appendEvent({
      type: 'mark:added',
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

    // Also check EmbeddingStore
    const { annotationId: makeAnnotationId } = await import('@semiont/core');
    const stored = await embeddingStore.readAnnotationEmbedding(makeAnnotationId('ann-1'));
    expect(stored).not.toBeNull();
    expect(stored!.model).toBe('mock-model');
    expect(stored!.text).toBe('Lincoln was a great leader');
    expect(stored!.motivation).toBe('highlighting');
  });

  it('deletes resource vectors on resource.archived', async () => {
    const content = Buffer.from('Content to be archived.');
    const uri = 'file://archive-me.txt';
    await contentStore.store(content, uri, { noGit: true });

    await eventStore.appendEvent({
      type: 'yield:created',
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

    const queryVec = deterministicEmbed('Content to be archived');
    let results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    await eventStore.appendEvent({
      type: 'mark:archived',
      resourceId: resourceId('res-archive'),
      userId: userId('user-1'),
      version: 1,
      payload: {},
    });
    await tick();

    results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBe(0);
  });

  it('rebuilds vector store from EmbeddingStore', async () => {
    const rid = resourceId('res-rebuild');
    const text = 'Rebuilding vectors from embedding store.';
    const embedding = deterministicEmbed(text);

    // Write directly to EmbeddingStore (simulating a prior run)
    await embeddingStore.writeResourceChunks(rid, 'mock-model', 4, [
      { chunkIndex: 0, text, embedding },
    ]);

    // Vector store is empty — nothing indexed yet
    const queryVec = deterministicEmbed(text);
    let results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBe(0);

    await smelter.rebuildAll();

    results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].resourceId).toBe(String(rid));
    // rebuildAll should not have called the provider (model matches)
    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();
  });

  it('back-fills resources missing an embedding file during rebuildAll', async () => {
    const content = Buffer.from('Missing embedding file content.');
    const uri = 'file://missing-embed.txt';
    await contentStore.store(content, uri, { noGit: true });

    // Write a materialized view directly (simulating a completed view rebuild
    // with no corresponding embedding file — the gap rebuildAll must fill)
    const rid = resourceId('res-backfill');
    await viewStorage.save(rid, {
      resource: {
        '@context': 'https://schema.org',
        '@id': String(rid),
        name: 'Backfill Me',
        archived: false,
        storageUri: uri,
        representations: [],
      },
      annotations: { annotations: [] },
    });

    // Confirm no embedding file exists
    const before = await embeddingStore.readResourceEmbeddings(rid);
    expect(before).toBeNull();

    // rebuildAll should detect the gap and back-fill
    await smelter.rebuildAll();

    // File should now exist
    const after = await embeddingStore.readResourceEmbeddings(rid);
    expect(after).not.toBeNull();
    expect(after!.chunks.length).toBeGreaterThan(0);

    // And Qdrant should have it
    const queryVec = deterministicEmbed('Missing embedding file content');
    const results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('re-embeds on model mismatch during rebuildAll', async () => {
    const rid = resourceId('res-stale-model');
    const text = 'This was embedded with an old model.';
    const staleEmbedding = deterministicEmbed(text);

    // Write with a different (stale) model name
    await embeddingStore.writeResourceChunks(rid, 'old-model', 4, [
      { chunkIndex: 0, text, embedding: staleEmbedding },
    ]);

    await smelter.rebuildAll();

    // Provider should have been called to re-embed
    expect(embeddingProvider.embedBatch).toHaveBeenCalled();

    // File should now reflect the current model
    const stored = await embeddingStore.readResourceEmbeddings(rid);
    expect(stored!.model).toBe('mock-model');
  });

  it('stops cleanly', async () => {
    await smelter.stop();
  });
});
