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
import type { EventMap, components } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import { calculateChecksum } from '@semiont/content';
import { MemoryVectorStore } from '@semiont/vectors';
import type { EmbeddingProvider } from '@semiont/vectors';
import type { BusRequestPrimitive } from '@semiont/core';
import { Smelter } from '../smelter';
import type { SmelterEvent } from '../smelter-actor-state-unit';
import {
  mockLogger,
  deterministicEmbed,
  createMockEmbeddingProvider,
  annotationEvent,
  resourceDescriptor,
  createMockContentTransport,
  createFakeKsBus,
} from './helpers/smelter-harness';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

const tick = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

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
      { burstWindowMs: 50, maxBatchSize: 100, idleTimeoutMs: 200 },
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

describe('Smelter.reconcile', () => {
  let vectorStore: MemoryVectorStore;
  let embeddingProvider: EmbeddingProvider;
  let contentByResourceId: Map<string, string>;
  let smelters: Smelter[];

  beforeEach(async () => {
    vectorStore = new MemoryVectorStore();
    await vectorStore.connect();
    embeddingProvider = createMockEmbeddingProvider();
    contentByResourceId = new Map();
    smelters = [];
  });

  afterEach(() => {
    for (const smelter of smelters) smelter.stop();
  });

  // reconcile() drains its work items through the pipeline, so the smelter
  // must be initialized — same contract as smelter-main.
  function createSmelter(resources: ResourceDescriptor[]): Smelter {
    const smelter = new Smelter(
      new Subject<SmelterEvent>(),
      vectorStore,
      embeddingProvider,
      createMockContentTransport(contentByResourceId),
      createFakeKsBus(resources),
      { chunkSize: 512, overlap: 64 },
      { burstWindowMs: 50, maxBatchSize: 100, idleTimeoutMs: 200 },
      mockLogger,
    );
    smelter.initialize();
    smelters.push(smelter);
    return smelter;
  }

  // Convergence from arbitrary divergence is the S11 axiom property
  // (smelter-axioms.test.ts). These examples pin what S11's id-set
  // equality cannot: no wasted re-embedding, the catalog page boundary,
  // and the failure state machine.

  it('stamps a resource\'s entityTypes (read from the descriptor) onto its vectors', async () => {
    const text = 'What is the capital of France?';
    const checksum = calculateChecksum(text);
    contentByResourceId.set('res-q', text);

    // entityTypes live on the descriptor (the catalog), not the event payload —
    // the smelter reads the authoritative current state, so reconcile stamps them.
    const smelter = createSmelter([resourceDescriptor('res-q', 'text/plain', checksum, ['Question'])]);
    await smelter.reconcile();

    const queryVec = deterministicEmbed('capital of France');
    const all = await vectorStore.searchResources(queryVec, { limit: 5 });
    expect(all.find((r) => r.resourceId === 'res-q')?.entityTypes).toEqual(['Question']);

    // And the discriminator is usable: excludeEntityTypes drops it from recall.
    const excluded = await vectorStore.searchResources(queryVec, {
      limit: 5,
      filter: { excludeEntityTypes: ['Question'] },
    });
    expect(excluded.some((r) => r.resourceId === 'res-q')).toBe(false);
  });

  it('leaves already-indexed resources alone', async () => {
    const text = 'Already indexed.';
    const checksum = calculateChecksum(text);
    contentByResourceId.set('res-indexed', text);
    await vectorStore.upsertResourceVectors(
      makeResourceId('res-indexed'),
      [{ chunkIndex: 0, text, embedding: deterministicEmbed(text) }],
      checksum,
      [],
    );

    const smelter = createSmelter([resourceDescriptor('res-indexed', 'text/plain', checksum)]);
    const summary = await smelter.reconcile();

    expect(summary.resourcesEmbedded).toBe(0);
    expect(embeddingProvider.embedBatch).not.toHaveBeenCalled();
    expect(smelter.reconcileState).toEqual({ phase: 'done', summary });
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
    expect((await vectorStore.listResourceChecksums()).size).toBe(250);
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
      { burstWindowMs: 50, maxBatchSize: 100, idleTimeoutMs: 200 },
      mockLogger,
    );
    smelter.initialize();
    smelters.push(smelter);

    await expect(smelter.reconcile()).rejects.toThrow('bus down');
    expect(smelter.reconcileState).toEqual({ phase: 'failed', error: 'bus down' });
  });
});
