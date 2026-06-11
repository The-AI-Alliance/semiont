/**
 * Smelter Tests
 *
 * Tests the Smelter worker pipeline:
 * - Resource embedding and indexing (via embedBatch) on yield:created
 * - Re-embedding on yield:updated / yield:representation-added
 * - Annotation embedding and indexing on mark:added
 * - Deletion handling (mark:archived, mark:removed)
 * - Burst batching: same-type runs share one embedBatch() call
 * - Mixed-type bursts partitioned into ordered runs
 * - Startup reconciliation against a fake KS catalog
 *
 * Drives the pipeline with a plain RxJS Subject standing in for the
 * SmelterActorStateUnit's events$, a mock IContentTransport standing in
 * for the content store, and a fake bus serving the browse RPC channels.
 * Uses MemoryVectorStore and a mock EmbeddingProvider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import type { Logger, EventMap, IContentTransport, components } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { MemoryVectorStore } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { BusRequestPrimitive } from '@semiont/sdk';
import { Smelter, isEmbeddableMediaType } from '../smelter';
import type { SmelterEvent } from '../smelter-actor-state-unit';
import { partitionByType } from '../batch-utils';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

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

function makeAnnotation(resourceId: string, annotationId: string, exact: string): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId,
    motivation: 'highlighting',
    target: {
      source: resourceId,
      selector: {
        type: 'TextQuoteSelector',
        exact,
      },
    },
    created: new Date().toISOString(),
  };
}

function annotationEvent(resourceId: string, annotationId: string, exact: string): SmelterEvent {
  return {
    type: 'mark:added',
    resourceId,
    payload: {
      resourceId,
      annotation: makeAnnotation(resourceId, annotationId, exact),
    },
  };
}

function resourceDescriptor(id: string, mediaType = 'text/plain'): ResourceDescriptor {
  return {
    '@context': 'https://schema.org',
    '@id': id,
    name: id,
    representations: [{ mediaType, storageUri: `file://${id}.txt` }],
  };
}

/**
 * IContentTransport over an in-memory map, mirroring WorkerContentTransport
 * semantics: unknown resources throw rather than returning null.
 */
function createMockContentTransport(
  contentByResourceId: Map<string, string>,
  contentType = 'text/plain',
): IContentTransport {
  return {
    async putBinary() {
      throw new Error('not supported');
    },
    async getBinary(resourceId) {
      const text = contentByResourceId.get(String(resourceId));
      if (text === undefined) throw new Error(`Resource not found: ${resourceId}`);
      const bytes = new TextEncoder().encode(text);
      const data = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(data).set(bytes);
      return { data, contentType };
    },
    async getBinaryStream() {
      throw new Error('not used in tests');
    },
    dispose() {},
  };
}

/**
 * BusRequestPrimitive serving the browse RPC channels from a fake catalog,
 * with the same correlationId request/reply protocol the Browser actor uses.
 */
function createFakeKsBus(
  resources: ResourceDescriptor[],
  annotationsByResource: Map<string, Annotation[]> = new Map(),
): BusRequestPrimitive {
  const channels = new Map<string, Subject<Record<string, unknown>>>();
  const channel = (name: string): Subject<Record<string, unknown>> => {
    let subject = channels.get(name);
    if (!subject) {
      subject = new Subject<Record<string, unknown>>();
      channels.set(name, subject);
    }
    return subject;
  };

  return {
    async emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<void> {
      const request = payload as Record<string, unknown>;
      if (name === 'browse:resources-requested') {
        const offset = (request.offset as number | undefined) ?? 0;
        const limit = (request.limit as number | undefined) ?? 50;
        queueMicrotask(() => channel('browse:resources-result').next({
          correlationId: request.correlationId,
          response: {
            resources: resources.slice(offset, offset + limit),
            total: resources.length,
            offset,
            limit,
          },
        }));
      } else if (name === 'browse:annotations-requested') {
        const annotations = annotationsByResource.get(request.resourceId as string) ?? [];
        queueMicrotask(() => channel('browse:annotations-result').next({
          correlationId: request.correlationId,
          response: { annotations, total: annotations.length },
        }));
      }
    },
    stream<K extends keyof EventMap>(name: K): Observable<EventMap[K]> {
      return channel(name as string) as unknown as Observable<EventMap[K]>;
    },
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
    ];

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
    ];

    const runs = partitionByType(events);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(partitionByType([])).toEqual([]);
  });
});

describe('Smelter', () => {
  let events$: Subject<SmelterEvent>;
  let vectorStore: MemoryVectorStore;
  let embeddingProvider: EmbeddingProvider;
  let contentByResourceId: Map<string, string>;
  let smelter: Smelter;

  beforeEach(async () => {
    events$ = new Subject<SmelterEvent>();
    vectorStore = new MemoryVectorStore();
    await vectorStore.connect();
    embeddingProvider = createMockEmbeddingProvider();
    contentByResourceId = new Map();

    smelter = new Smelter(
      events$,
      vectorStore,
      embeddingProvider,
      createMockContentTransport(contentByResourceId),
      createFakeKsBus([]),
      { chunkSize: 512, overlap: 64 },
      mockLogger,
    );
    smelter.initialize();
  });

  afterEach(() => {
    smelter.stop();
  });

  it('initializes without error', () => {
    expect(smelter).toBeDefined();
  });

  it('indexes resource vectors on yield:created', async () => {
    contentByResourceId.set('res-fox', 'The quick brown fox jumps over the lazy dog.');

    events$.next({ type: 'yield:created', resourceId: 'res-fox', payload: {} });
    await tick();

    expect(embeddingProvider.embedBatch).toHaveBeenCalled();
    const queryVec = deterministicEmbed('quick brown fox');
    const results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].resourceId).toBe('res-fox');
  });

  it('skips resources whose content cannot be fetched', async () => {
    events$.next({ type: 'yield:created', resourceId: 'res-missing', payload: {} });
    await tick();

    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();
  });

  it('re-embeds resource when yield:updated fires', async () => {
    contentByResourceId.set('res-updated', 'Initial content for update test.');
    events$.next({ type: 'yield:created', resourceId: 'res-updated', payload: {} });
    await tick();

    const callsAfterCreate = (embeddingProvider.embedBatch as ReturnType<typeof vi.fn>).mock.calls.length;

    contentByResourceId.set('res-updated', 'Replaced content after update event.');
    events$.next({ type: 'yield:updated', resourceId: 'res-updated', payload: {} });
    await tick();

    const callsAfterUpdate = (embeddingProvider.embedBatch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterUpdate).toBeGreaterThan(callsAfterCreate);
    expect(embeddingProvider.embedBatch).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.stringContaining('Replaced content')]),
    );
  });

  it('re-embeds resource when yield:representation-added fires', async () => {
    contentByResourceId.set('res-repr', 'Resource with a new representation.');
    events$.next({ type: 'yield:created', resourceId: 'res-repr', payload: {} });
    await tick();

    const callsAfterCreate = (embeddingProvider.embedBatch as ReturnType<typeof vi.fn>).mock.calls.length;

    events$.next({ type: 'yield:representation-added', resourceId: 'res-repr', payload: {} });
    await tick();

    const callsAfterRepr = (embeddingProvider.embedBatch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterRepr).toBeGreaterThan(callsAfterCreate);
  });

  it('indexes annotation text on mark:added', async () => {
    events$.next(annotationEvent('res-1', 'ann-1', 'Lincoln was a great leader'));
    await tick();

    expect(embeddingProvider.embed).toHaveBeenCalledWith('Lincoln was a great leader');
    const queryVec = deterministicEmbed('Lincoln was a great leader');
    const results = await vectorStore.searchAnnotations(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('deletes resource vectors on mark:archived', async () => {
    contentByResourceId.set('res-archive', 'Content to be archived.');
    events$.next({ type: 'yield:created', resourceId: 'res-archive', payload: {} });
    await tick();

    const queryVec = deterministicEmbed('Content to be archived');
    let results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    events$.next({ type: 'mark:archived', resourceId: 'res-archive', payload: {} });
    await tick();

    results = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(results.length).toBe(0);
  });

  it('deletes annotation vector on mark:removed', async () => {
    events$.next(annotationEvent('res-1', 'ann-removed', 'Soon to be removed'));
    await tick();

    const queryVec = deterministicEmbed('Soon to be removed');
    let results = await vectorStore.searchAnnotations(queryVec, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    events$.next({ type: 'mark:removed', resourceId: 'res-1', payload: { annotationId: 'ann-removed' } });
    await tick();

    results = await vectorStore.searchAnnotations(queryVec, { limit: 5 });
    expect(results.length).toBe(0);
  });

  it('batches a burst of yield:created events after the leading edge', async () => {
    contentByResourceId.set('res-burst', 'Burst content for batch embedding.');

    // burstBuffer is leading-edge: the first event passes through solo, the
    // next two accumulate into one batch → one embedBatch call covering both.
    events$.next({ type: 'yield:created', resourceId: 'res-burst', payload: {} });
    events$.next({ type: 'yield:created', resourceId: 'res-burst', payload: {} });
    events$.next({ type: 'yield:created', resourceId: 'res-burst', payload: {} });
    await tick();

    expect(embeddingProvider.embedBatch).toHaveBeenCalledTimes(2);
    const lastCall = (embeddingProvider.embedBatch as ReturnType<typeof vi.fn>).mock.lastCall;
    expect(lastCall![0]).toHaveLength(2);
  });

  it('processes mixed-type bursts as ordered same-type runs', async () => {
    contentByResourceId.set('res-mixed', 'Mixed burst resource content.');

    events$.next({ type: 'yield:created', resourceId: 'res-mixed', payload: {} });
    events$.next(annotationEvent('res-mixed', 'ann-mixed', 'mixed burst annotation'));
    await tick();

    expect(embeddingProvider.embedBatch).toHaveBeenCalled();
    expect(embeddingProvider.embed).toHaveBeenCalledWith('mixed burst annotation');
    const results = await vectorStore.searchAnnotations(deterministicEmbed('mixed burst annotation'), { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('counts processed events for the health endpoint', async () => {
    contentByResourceId.set('res-count', 'Counted content.');
    events$.next({ type: 'yield:created', resourceId: 'res-count', payload: {} });
    await tick();

    expect(smelter.eventsProcessed).toBeGreaterThan(0);
  });

  it('stops cleanly', () => {
    smelter.stop();
  });
});

describe('isEmbeddableMediaType', () => {
  it('accepts text media types and rejects binary ones', () => {
    expect(isEmbeddableMediaType('text/plain')).toBe(true);
    expect(isEmbeddableMediaType('text/markdown')).toBe(true);
    expect(isEmbeddableMediaType('application/pdf')).toBe(false);
    expect(isEmbeddableMediaType('image/png')).toBe(false);
    expect(isEmbeddableMediaType(undefined)).toBe(false);
  });
});

describe('Smelter.reconcile', () => {
  let vectorStore: MemoryVectorStore;
  let embeddingProvider: EmbeddingProvider;
  let contentByResourceId: Map<string, string>;

  beforeEach(async () => {
    vectorStore = new MemoryVectorStore();
    await vectorStore.connect();
    embeddingProvider = createMockEmbeddingProvider();
    contentByResourceId = new Map();
  });

  function createSmelter(
    resources: ResourceDescriptor[],
    annotationsByResource: Map<string, Annotation[]> = new Map(),
  ): Smelter {
    return new Smelter(
      new Subject<SmelterEvent>(),
      vectorStore,
      embeddingProvider,
      createMockContentTransport(contentByResourceId),
      createFakeKsBus(resources, annotationsByResource),
      { chunkSize: 512, overlap: 64 },
      mockLogger,
    );
  }

  it('re-embeds resources missing from a wiped vector store', async () => {
    contentByResourceId.set('res-a', 'Alpha content for reconcile.');
    contentByResourceId.set('res-b', 'Beta content for reconcile.');

    const smelter = createSmelter([resourceDescriptor('res-a'), resourceDescriptor('res-b')]);
    const summary = await smelter.reconcile();

    expect(summary.resourcesEmbedded).toBe(2);
    expect(await vectorStore.listResourceIds()).toEqual(new Set(['res-a', 'res-b']));
    expect(smelter.reconcileState).toEqual({ phase: 'done', summary });
  });

  it('leaves already-indexed resources alone', async () => {
    contentByResourceId.set('res-indexed', 'Already indexed.');
    await vectorStore.upsertResourceVectors(
      makeResourceId('res-indexed'),
      [{ chunkIndex: 0, text: 'Already indexed.', embedding: deterministicEmbed('Already indexed.') }],
    );

    const smelter = createSmelter([resourceDescriptor('res-indexed')]);
    const summary = await smelter.reconcile();

    expect(summary.resourcesEmbedded).toBe(0);
    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();
  });

  it('deletes vectors for resources no longer in the catalog', async () => {
    await vectorStore.upsertResourceVectors(
      makeResourceId('res-gone'),
      [{ chunkIndex: 0, text: 'stale', embedding: deterministicEmbed('stale') }],
    );

    const smelter = createSmelter([]);
    const summary = await smelter.reconcile();

    expect(summary.resourceVectorsDeleted).toBe(1);
    expect(await vectorStore.listResourceIds()).toEqual(new Set());
  });

  it('treats vectors of non-text resources as orphans and skips re-embedding them', async () => {
    await vectorStore.upsertResourceVectors(
      makeResourceId('res-pdf'),
      [{ chunkIndex: 0, text: 'mojibake', embedding: deterministicEmbed('mojibake') }],
    );

    const smelter = createSmelter([resourceDescriptor('res-pdf', 'application/pdf')]);
    const summary = await smelter.reconcile();

    expect(summary.resourceVectorsDeleted).toBe(1);
    expect(summary.resourcesEmbedded).toBe(0);
    expect(await vectorStore.listResourceIds()).toEqual(new Set());
  });

  it('embeds missing annotations and deletes orphaned annotation vectors', async () => {
    contentByResourceId.set('res-ann', 'Annotated resource content.');
    await vectorStore.upsertResourceVectors(
      makeResourceId('res-ann'),
      [{ chunkIndex: 0, text: 'Annotated resource content.', embedding: deterministicEmbed('Annotated') }],
    );
    await vectorStore.upsertAnnotationVector(
      makeAnnotationId('ann-orphan'),
      deterministicEmbed('orphan'),
      {
        annotationId: makeAnnotationId('ann-orphan'),
        resourceId: makeResourceId('res-ann'),
        motivation: 'highlighting',
        entityTypes: [],
        exactText: 'orphan',
      },
    );

    const smelter = createSmelter(
      [resourceDescriptor('res-ann')],
      new Map([['res-ann', [makeAnnotation('res-ann', 'ann-live', 'live annotation text')]]]),
    );
    const summary = await smelter.reconcile();

    expect(summary.annotationsEmbedded).toBe(1);
    expect(summary.annotationVectorsDeleted).toBe(1);
    expect(await vectorStore.listAnnotationIds()).toEqual(new Set(['ann-live']));
  });

  it('pages through catalogs larger than one page', async () => {
    const resources: ResourceDescriptor[] = [];
    for (let i = 0; i < 250; i++) {
      const id = `res-page-${i}`;
      resources.push(resourceDescriptor(id));
      contentByResourceId.set(id, `Content ${i}.`);
    }

    const smelter = createSmelter(resources);
    const summary = await smelter.reconcile();

    expect(summary.resourcesEmbedded).toBe(250);
    expect((await vectorStore.listResourceIds()).size).toBe(250);
  });

  it('records failure state when the catalog is unreachable', async () => {
    const deadBus: BusRequestPrimitive = {
      async emit() {
        throw new Error('bus down');
      },
      stream<K extends keyof EventMap>(): Observable<EventMap[K]> {
        return new Subject<EventMap[K]>();
      },
    };
    const smelter = new Smelter(
      new Subject<SmelterEvent>(),
      vectorStore,
      embeddingProvider,
      createMockContentTransport(contentByResourceId),
      deadBus,
      { chunkSize: 512, overlap: 64 },
      mockLogger,
    );

    await expect(smelter.reconcile()).rejects.toThrow('bus down');
    expect(smelter.reconcileState).toEqual({ phase: 'failed', error: 'bus down' });
  });
});
