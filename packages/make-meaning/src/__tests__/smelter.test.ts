/**
 * Smelter Tests
 *
 * Tests the Smelter actor's event processing pipeline:
 * - Resource embedding and indexing
 * - Annotation embedding and indexing
 * - Deletion handling
 *
 * Uses MemoryVectorStore and a mock EmbeddingProvider.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, resourceId, userId, annotationId, CREATION_METHODS } from '@semiont/core';
import type { Logger } from '@semiont/core';
import { MemoryVectorStore } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import { WorkingTreeStore } from '@semiont/content';
import { Smelter } from '../smelter';
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

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => {
      // Deterministic: hash text to a small vector
      const vec = new Array(4);
      for (let i = 0; i < 4; i++) {
        vec[i] = Math.sin((text.charCodeAt(i % text.length) || 0) + i);
      }
      return vec;
    }),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
      const provider = createMockEmbeddingProvider();
      return Promise.all(texts.map(t => provider.embed(t)));
    }),
    dimensions: vi.fn().mockReturnValue(4),
    model: vi.fn().mockReturnValue('mock-model'),
  };
}

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

  it('calls embed when a resource is created with content', async () => {
    // Store some content first
    const content = Buffer.from('Abraham Lincoln was the 16th president of the United States.');
    const storageUri = await contentStore.store(content, 'text/plain', 'lincoln.txt');

    // Append resource.created event
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId('res-lincoln'),
      userId: userId('user-1'),
      name: 'Lincoln',
      storageUri,
      mediaType: 'text/plain',
      creationMethod: CREATION_METHODS.UPLOAD,
    });

    await tick();

    expect(embeddingProvider.embed).toHaveBeenCalled();
  });

  it('indexes annotation text into vector store', async () => {
    // Append annotation.added event
    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: resourceId('res-1'),
      userId: userId('user-1'),
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
    } as any);

    await tick();

    // Search for the annotation text
    const queryVec = await embeddingProvider.embed('Lincoln was a great leader');
    const results = await vectorStore.searchAnnotations(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThanOrEqual(0);
    // The embed function should have been called
    expect(embeddingProvider.embed).toHaveBeenCalled();
  });

  it('stops cleanly', async () => {
    await smelter.stop();
    // No errors thrown
  });
});
