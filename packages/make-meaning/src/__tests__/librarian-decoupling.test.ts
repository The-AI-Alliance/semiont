/**
 * The decoupling proof for `Matcher`.
 *
 * The Matcher constructs from narrow capability doubles: an actor that can
 * be built and exercised from the slices it names holds nothing else.
 *
 * The capability shape is the actor's honest surface:
 * - graph.listResources — name-match + entity-type retrieval sources
 * - graph.getResource + views.get — `resourceWithViewGrace`'s two halves
 *   (the view fallback is why "Matcher needs no filesystem" is false)
 * - vectors.searchResources — the semantic retrieval source
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { take } from 'rxjs/operators';
import { EventBus, resourceId, type GatheredContext, type Logger, type ResourceDescriptor, annotationId } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import { Matcher, type MatcherStores } from '../matcher';
import { MATCHER_CHANNELS } from '../service-channels';
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
  id: annotationId('test-ann'),
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  motivation: 'linking',
  created: '2026-01-01T00:00:00.000Z',
  target: { source: resourceId(MAIN_ID) },
};

const testSourceResource: AnnotationFocus['sourceResource'] = {
  '@context': 'https://schema.org',
  '@id': resourceId(MAIN_ID),
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
    graph: { nodes: [{ id: resourceId(MAIN_ID), type: 'resource', label: 'Test Resource' }], edges: [] },
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

describe('Matcher decoupling', () => {
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

    const resultPromise = eventBus.on('match:search-results').pipe(take(1)).toPromise();
    eventBus.emit('match:search-requested', {
      resourceId: resourceId(MAIN_ID),
      referenceId: annotationId('ref-1'),
      context: makeContext('test query'),
    }, { correlationId: 'corr-1' });

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

    const resultPromise = eventBus.on('match:search-results').pipe(take(1)).toPromise();
    eventBus.emit('match:search-requested', {
      resourceId: resourceId(MAIN_ID),
      referenceId: annotationId('ref-2'),
      context: makeContext('fresh thing'),
    }, { correlationId: 'corr-2' });

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

    const matcher = new Matcher(
      makeStores(), bus, mockLogger, noopInference, createMockEmbeddingProvider(),
    );
    await matcher.initialize();
    await matcher.stop();
    bus.destroy();

    expect(new Set(seen)).toEqual(new Set(MATCHER_CHANNELS));
  });
});

// The matcher holds its model's inference credential, so it answers for that
// model's limits; nothing without a key could discover them.
describe('Matcher reports its model\'s limits', () => {
  it('answers match:limits-requested with its own client\'s limits', async () => {
    const { firstValueFrom, take: takeOne } = await import('rxjs');
    const limits = { contextTokens: 200_000, maxOutputTokens: 64_000 };
    const client: InferenceClient = { ...noopInference, type: 'anthropic', modelId: 'm-matcher', limits: async () => limits };
    const bus = new EventBus();
    const actor = new Matcher(makeStores(), bus, mockLogger, client, createMockEmbeddingProvider());
    await actor.initialize();
    try {
      const reply = firstValueFrom(bus.frames('match:limits-result').pipe(takeOne(1)));
      bus.emit('match:limits-requested', {}, { correlationId: 'cid-matcher' });
      const frame = await reply;
      expect(frame.correlationId).toBe('cid-matcher');
      expect(frame.payload.response.limits).toEqual([{ provider: 'anthropic', model: 'm-matcher', limits }]);
    } finally {
      await actor.stop();
      bus.destroy();
    }
  });
});
