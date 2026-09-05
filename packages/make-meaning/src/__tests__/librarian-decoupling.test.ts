/**
 * EXTRACT-LIBRARIAN P1 — the decoupling proof for `Matcher`.
 *
 * The Matcher constructs from narrow capability doubles. `KnowledgeBase`
 * appears nowhere in this file — that absence IS the test: if the actor can
 * be built and exercised without the god-object, it is decoupled.
 *
 * The capability shape is the actor's honest surface, measured 2026-08-28:
 * - graph.listResources — name-match + entity-type retrieval sources
 * - graph.getResource + views.get — `resourceWithViewGrace`'s two halves
 *   (the view fallback is why "Matcher needs no filesystem" was wrong)
 * - vectors.searchResources — the semantic retrieval source
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, resourceId, type GatheredContext, type Logger, type ResourceDescriptor } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import { Matcher, MATCHER_CHANNELS, type MatcherStores } from '../matcher';
import { createMockEmbeddingProvider } from './helpers/smelter-harness';

type ListResources = MatcherStores['graph']['listResources'];
type GetResource = MatcherStores['graph']['getResource'];
type ViewsGet = MatcherStores['views']['get'];
type SearchResources = MatcherStores['vectors']['searchResources'];

type AnnotationFocus = Extract<GatheredContext['focus'], { kind: 'annotation' }>;

const MAIN_ID = 'test-resource';

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

const testAnnotation: AnnotationFocus['annotation'] = {
  id: 'test-ann',
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  motivation: 'linking',
  target: { source: MAIN_ID },
  body: { type: 'SpecificResource', source: '' },
};

const testSourceResource: AnnotationFocus['sourceResource'] = {
  '@context': 'https://schema.org',
  '@id': MAIN_ID,
  name: 'Test Resource',
  format: 'text/plain',
  representations: [],
};

function makeContext(text: string): GatheredContext {
  return {
    focus: {
      kind: 'annotation',
      annotation: testAnnotation,
      sourceResource: testSourceResource,
      selected: { before: '', text, after: '' },
    },
    graph: { nodes: [{ id: MAIN_ID, type: 'resource', label: 'Test Resource' }], edges: [] },
    metadata: {},
  };
}

const descriptor = (id: string, name: string): ResourceDescriptor => ({
  '@context': 'https://schema.org',
  '@id': resourceId(id),
  name,
  format: 'text/plain',
  representations: [],
});

function makeStores(overrides: {
  listResources?: ListResources;
  getResource?: GetResource;
  viewsGet?: ViewsGet;
  searchResources?: SearchResources;
} = {}): MatcherStores {
  return {
    graph: {
      listResources: overrides.listResources ?? (async () => ({ resources: [], total: 0 })),
      getResource: overrides.getResource ?? (async () => null),
    },
    views: { get: overrides.viewsGet ?? (async () => null) },
    vectors: { searchResources: overrides.searchResources ?? (async () => []) },
  };
}

describe('Matcher decoupling (EXTRACT-LIBRARIAN P1)', () => {
  let matcher: Matcher | undefined;
  let eventBus: EventBus;

  afterEach(async () => {
    await matcher?.stop();
    matcher = undefined;
    eventBus?.destroy();
  });

  it('constructs from narrow doubles and answers a search', async () => {
    eventBus = new EventBus();
    const listResources = vi.fn<ListResources>(async (filter) =>
      filter?.search
        ? { resources: [descriptor('r1', 'Resource 1')], total: 1 }
        : { resources: [], total: 0 },
    );
    matcher = new Matcher(
      makeStores({ listResources }),
      eventBus, mockLogger, noopInference, createMockEmbeddingProvider(),
    );
    await matcher.initialize();

    const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();
    eventBus.get('match:search-requested').next({
      resourceId: MAIN_ID,
      correlationId: 'corr-1',
      referenceId: 'ref-1',
      context: makeContext('test query'),
    });

    const result = await resultPromise;
    expect(result!.response).toHaveLength(1);
    expect(result!.response[0]).toMatchObject({ '@id': 'r1', name: 'Resource 1' });
    expect(listResources).toHaveBeenCalledWith({ search: 'test query', limit: 20 });
  });

  it('hydrates a semantic hit from the view when the graph lags (grace on the boundary)', async () => {
    eventBus = new EventBus();
    const viewsGet = vi.fn<ViewsGet>(async (rid) => ({
      resource: descriptor('fresh', 'Fresh Resource'),
      annotations: { resourceId: rid, annotations: [], version: 0, updatedAt: '2026-08-28T00:00:00Z' },
    }));
    matcher = new Matcher(
      makeStores({
        searchResources: vi.fn<SearchResources>(async () => [
          { id: 'v1', score: 0.9, resourceId: resourceId('fresh'), text: 'fresh text' },
        ]),
        viewsGet,
      }),
      eventBus, mockLogger, noopInference, createMockEmbeddingProvider(),
    );
    await matcher.initialize();

    const resultPromise = eventBus.get('match:search-results').pipe(take(1)).toPromise();
    eventBus.get('match:search-requested').next({
      resourceId: MAIN_ID,
      correlationId: 'corr-2',
      referenceId: 'ref-2',
      context: makeContext('fresh thing'),
    });

    const result = await resultPromise;
    expect(result!.response).toHaveLength(1);
    expect(result!.response[0]).toMatchObject({ '@id': 'fresh', name: 'Fresh Resource' });
    expect(viewsGet).toHaveBeenCalledWith('fresh');
  });
});

// ── Channel roster census gate ────────────────────────────────────────────────
//
// librarian-main derives its SSE subscription from the exported
// MATCHER_CHANNELS roster. This gate pins the roster to the actor's ACTUAL
// subscriptions: add a subscription without growing the roster (or vice
// versa) and the gate fails — the mirror cannot drift silently.

describe('channel roster matches actual subscriptions (census gate)', () => {
  it('Matcher', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const realGet = bus.get.bind(bus);
    bus.get = ((channel) => {
      // Requests only: initialize() also calls get() to hold the reply
      // channels it emits on; the roster is what it CONSUMES.
      seen.push(channel as string);
      return realGet(channel);
    }) as typeof bus.get;

    const matcher = new Matcher(
      makeStores(), bus, mockLogger, noopInference, createMockEmbeddingProvider(),
    );
    await matcher.initialize();
    await matcher.stop();
    bus.destroy();

    expect(new Set(seen)).toEqual(new Set(MATCHER_CHANNELS));
  });
});
