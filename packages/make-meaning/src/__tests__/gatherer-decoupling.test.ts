/**
 * EXTRACT-LIBRARIAN P2 — the decoupling proof for `Gatherer`.
 *
 * The Gatherer constructs from narrow capability doubles. `KnowledgeBase`
 * appears nowhere in this file — that absence IS the test: if the actor can
 * be built and exercised without the god-object, it is decoupled.
 *
 * The capability shape is the whole Gatherer-path surface, measured
 * 2026-08-28 (the union of buildLLMContext + getResourceContext +
 * generateAnnotationSummary, transitively through buildKnowledgeGraph):
 * views.get · content.retrieve · five graph reads · two vector searches ·
 * the weave and smelt progress folds.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, resourceId, type Logger, type ResourceDescriptor } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import { Gatherer, GATHERER_CHANNELS, type GathererStores } from '../gatherer';
import { createMockEmbeddingProvider } from './helpers/smelter-harness';

const MAIN_ID = 'gather-target';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const noopInference = {
  type: 'noop',
  modelId: 'noop',
  maxConcurrency: 1,
  verifyDetectionYield: false,
  generateText: vi.fn().mockResolvedValue(''),
  generateTextWithMetadata: vi.fn().mockResolvedValue({ text: '', usage: {} }),
} as unknown as InferenceClient;

const descriptor = (id: string, name: string): ResourceDescriptor => ({
  '@context': 'https://schema.org',
  '@id': resourceId(id),
  name,
  format: 'text/plain',
  representations: [],
});

function makeStores(overrides: Partial<GathererStores> = {}): GathererStores {
  return {
    views: {
      get: async (rid) => ({
        resource: descriptor(String(rid), 'Gather Target'),
        annotations: { resourceId: rid, annotations: [], version: 0, updatedAt: '2026-08-28T00:00:00Z' },
      }),
    },
    content: { getBinary: async () => ({ data: new ArrayBuffer(0), contentType: 'text/plain' }) },
    anchoredText: async () => ({ kind: 'unknown' as const }),
    graph: {
      getResource: async (rid) => descriptor(String(rid), 'Gather Target'),
      getResourceConnections: async () => [],
      getResourceReferencedBy: async () => [],
      getResourceAnnotations: async () => [],
      getEntityTypeStats: async () => [],
    },
    vectors: {
      searchAnnotations: async () => [],
      searchByResource: async () => [],
    },
    weaveProgress: { whenApplied: async () => {} },
    smeltProgress: { whenSettled: async () => 'inert' as const },
    ...overrides,
  };
}

describe('Gatherer decoupling (EXTRACT-LIBRARIAN P2)', () => {
  let gatherer: Gatherer | undefined;
  let eventBus: EventBus;

  afterEach(async () => {
    await gatherer?.stop();
    gatherer = undefined;
    eventBus?.destroy();
  });

  it('constructs from narrow doubles and answers a resource gather', async () => {
    eventBus = new EventBus();
    gatherer = new Gatherer(
      makeStores(), eventBus, noopInference, 1_000, mockLogger, createMockEmbeddingProvider(),
    );
    await gatherer.initialize();

    const resultPromise = eventBus.frames('gather:resource-complete').pipe(take(1)).toPromise();
    eventBus.emit('gather:resource-requested', {
      resourceId: MAIN_ID,
      options: { depth: 1, maxResources: 5, includeContent: false, includeSummary: false },
    }, { correlationId: 'corr-1' });

    const result = await resultPromise;
    expect(result!.correlationId).toBe('corr-1');
    expect(result!.payload.response.focus.kind).toBe('resource');
    if (result!.payload.response.focus.kind === 'resource') {
      expect(result!.payload.response.focus.resource.name).toBe('Gather Target');
    }
    expect(result!.payload.response.graph.nodes).toEqual([
      expect.objectContaining({ id: MAIN_ID, type: 'resource' }),
    ]);
  });

  it('rides the weave barrier when the graph lags the view (grace on the boundary)', async () => {
    eventBus = new EventBus();
    // Graph misses until whenApplied resolves — the projection-lag path.
    let applied = false;
    const whenApplied = vi.fn(async () => { applied = true; });
    gatherer = new Gatherer(
      makeStores({
        views: {
          get: async (rid) => ({
            resource: descriptor(String(rid), 'Lagging Target'),
            annotations: { resourceId: rid, annotations: [], version: 0, updatedAt: '2026-08-28T00:00:00Z' },
            lastSequence: 3,
          }),
        },
        graph: {
          getResource: async (rid) => (applied ? descriptor(String(rid), 'Lagging Target') : null),
          getResourceConnections: async () => [],
          getResourceReferencedBy: async () => [],
          getResourceAnnotations: async () => [],
          getEntityTypeStats: async () => [],
        },
        weaveProgress: { whenApplied },
      }),
      eventBus, noopInference, 1_000, mockLogger, createMockEmbeddingProvider(),
    );
    await gatherer.initialize();

    const resultPromise = eventBus.frames('gather:resource-complete').pipe(take(1)).toPromise();
    eventBus.emit('gather:resource-requested', {
      resourceId: MAIN_ID,
      options: { depth: 1, maxResources: 5, includeContent: false, includeSummary: false },
    }, { correlationId: 'corr-2' });

    const result = await resultPromise;
    expect(whenApplied).toHaveBeenCalledWith(MAIN_ID, 3, expect.any(Number));
    if (result!.payload.response.focus.kind === 'resource') {
      expect(result!.payload.response.focus.resource.name).toBe('Lagging Target');
    }
  });
});

// ── Channel roster census gate ────────────────────────────────────────────────
//
// librarian-main (P3) derives its SSE subscription from the exported
// GATHERER_CHANNELS roster. This gate pins the roster to the actor's ACTUAL
// subscriptions: add a subscription without growing the roster (or vice
// versa) and the gate fails — the mirror cannot drift silently.

describe('channel roster matches actual subscriptions (census gate)', () => {
  it('Gatherer', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const realOn = bus.on.bind(bus);
    const realFrames = bus.frames.bind(bus);
    // BOTH read verbs: an actor that reads frames for its envelope is no
    // less a subscriber than one that reads payloads.
    bus.on = ((channel) => {
      seen.push(channel as string);
      return realOn(channel);
    }) as typeof bus.on;
    bus.frames = ((channel) => {
      seen.push(channel as string);
      return realFrames(channel);
    }) as typeof bus.frames;

    const gatherer = new Gatherer(
      makeStores(), bus, noopInference, 1_000, mockLogger, createMockEmbeddingProvider(),
    );
    await gatherer.initialize();
    await gatherer.stop();
    bus.destroy();

    expect(new Set(seen)).toEqual(new Set(GATHERER_CHANNELS));
  });
});
