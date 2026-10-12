/**
 * A reference search, held to specs/src/librarian/score-cases.json: the table
 * every implementation of the Librarian runs, so that the candidates a search
 * answers, their scores and their reasons are stated once and not once per
 * language.
 *
 * Each case is run through the real Matcher on its bus. The stores, the
 * embedding provider and the model here answer what the case states and
 * nothing else, and the clock is set to the case's moment, since recency is
 * counted from it. What each source was asked is held to the case too: a
 * source the case does not state must not have been asked.
 *
 * The request, each resource and the answer are held to the spec's schemas,
 * so the table cannot state an object the bus could not carry.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { firstValueFrom, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { EventBus, resourceId, type EventMap, type Logger, type ResourceDescriptor, type ResourceFilter } from '@semiont/core';
import { formatErrors, validators } from '@semiont/core/openapi';
import type { InferenceClient } from '@semiont/inference';
import type { EmbeddingProvider } from '@semiont/vectors';
import { Matcher, type MatcherStores } from '../matcher';

type Listing = string[] | { fails: string };

interface Case {
  why: string;
  now: string;
  request: EventMap['match:search-requested'];
  resources: ResourceDescriptor[];
  graph: {
    byName?: Listing;
    byEntityType?: Listing;
    byId?: Record<string, 'held' | 'absent' | 'fails'>;
  };
  views?: Record<string, 'held' | 'absent'>;
  vectors?: { hits: { resourceId: string; score: number }[] } | { fails: true };
  model?: { shown: string[]; reply: string } | { shown: string[]; fails: true };
  term?: string;
  results?: { id: string; score: number; matchReason: string }[];
  failed?: string;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/librarian/score-cases.json', import.meta.url), 'utf8'),
);

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => silentLogger,
};

/** What a case's sources were asked, in the order they were asked it. */
interface Asked {
  byName: ResourceFilter[];
  byEntityType: ResourceFilter[];
  graphIds: string[];
  viewIds: string[];
  embedded: string[];
  vectorSearches: { limit: number; scoreThreshold?: number }[];
  prompts: string[];
}

/** The sources of one case: each answers what the case states, and notes what it was asked. */
function world(stated: Case): { stores: MatcherStores; embedding: EmbeddingProvider; model: InferenceClient; asked: Asked } {
  const asked: Asked = { byName: [], byEntityType: [], graphIds: [], viewIds: [], embedded: [], vectorSearches: [], prompts: [] };

  const described = new Map(stated.resources.map((resource) => [String(resource['@id']), resource]));
  const descriptionOf = (id: string): ResourceDescriptor => {
    const resource = described.get(id);
    if (!resource) throw new Error(`the case names ${id}, which its resources do not describe`);
    return resource;
  };

  const listed = (listing: Listing | undefined, source: string): ResourceDescriptor[] => {
    if (listing === undefined) throw new Error(`${source} was asked, and the case states no answer of it`);
    if (!Array.isArray(listing)) throw new Error(listing.fails);
    return listing.map(descriptionOf);
  };

  const stores: MatcherStores = {
    graph: {
      // The two listings are one method, told apart by the filter: the listing
      // by name is the one asked with a search term, whatever the term is.
      listResources: async (filter) => {
        const byName = 'search' in filter;
        (byName ? asked.byName : asked.byEntityType).push(filter);
        const resources = byName
          ? listed(stated.graph.byName, 'the listing by name')
          : listed(stated.graph.byEntityType, 'the listing by entity type');
        return { resources, total: resources.length };
      },
      getResource: async (id) => {
        asked.graphIds.push(String(id));
        const answer = stated.graph.byId?.[String(id)];
        if (answer === 'fails') throw new Error('the read of the graph failed');
        return answer === 'held' ? descriptionOf(String(id)) : null;
      },
    },
    views: {
      get: async (id) => {
        asked.viewIds.push(String(id));
        if (stated.views?.[String(id)] !== 'held') return null;
        // A view is its resource and what the view store keeps beside it,
        // which a reference search does not read.
        return {
          resource: descriptionOf(String(id)),
          annotations: { resourceId: id, annotations: [], version: 1, updatedAt: stated.now },
          lastSequence: 1,
        };
      },
    },
    vectors: {
      searchResources: async (_embedding, options) => {
        asked.vectorSearches.push({ limit: options.limit, scoreThreshold: options.scoreThreshold });
        if (stated.vectors === undefined) throw new Error('the vector index was asked, and the case states no answer of it');
        if ('fails' in stated.vectors) throw new Error('the vector index failed');
        // A hit is a passage of a resource. The search reads whose it is and its score.
        return stated.vectors.hits.map((hit, index) => ({
          id: `point-${index}`,
          score: hit.score,
          resourceId: resourceId(hit.resourceId),
          text: '',
        }));
      },
    },
  };

  const embedding: EmbeddingProvider = {
    embed: async (text) => {
      asked.embedded.push(text);
      return [1, 0, 0, 0];
    },
    dimensions: async () => 4,
  };

  const neverAsked = async (): Promise<never> => {
    throw new Error('a reference search asks its model for text, and for nothing else');
  };
  const model: InferenceClient = {
    type: 'stated',
    modelId: 'stated',
    maxConcurrency: 1,
    verifyDetectionYield: false,
    limits: neverAsked,
    generateText: async (prompt) => {
      asked.prompts.push(prompt);
      if (stated.model === undefined) throw new Error('the model was asked, and the case states no answer of it');
      if ('fails' in stated.model) throw new Error('the model failed');
      return stated.model.reply;
    },
    generateTextWithMetadata: neverAsked,
    generateStructured: neverAsked,
  };

  return { stores, embedding, model, asked };
}

/** The ids of the candidates a score prompt lists, in the order it numbers them. */
function shownIn(prompt: string): string[] {
  return [...prompt.matchAll(/^\d+\. ".*" \(id: (.+), types: .*\)$/gm)].map((line) => line[1]);
}

const distinct = (ids: string[]): string[] => [...new Set(ids)].sort();

describe('a reference search (specs/src/librarian/score-cases.json)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has cases, each of an answer or of a failure and not of both', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    for (const stated of table.cases) {
      expect([stated.results !== undefined, stated.failed !== undefined].filter(Boolean), stated.why).toHaveLength(1);
      expect(Number.isNaN(Date.parse(stated.now)), stated.why).toBe(false);
    }
  });

  it('has a case of each source failing or not asked, of the model in each way, of a view read and of a limit', () => {
    const some = (holds: (stated: Case) => boolean) => expect(table.cases.some(holds)).toBe(true);
    some((stated) => stated.failed !== undefined);
    some((stated) => stated.results !== undefined && stated.vectors === undefined);
    some((stated) => stated.vectors !== undefined && 'fails' in stated.vectors);
    some((stated) => stated.vectors !== undefined && 'hits' in stated.vectors && stated.vectors.hits.length > 0);
    some((stated) => stated.graph.byEntityType !== undefined);
    some((stated) => Object.values(stated.graph.byId ?? {}).includes('fails'));
    some((stated) => Object.values(stated.views ?? {}).includes('held'));
    some((stated) => Object.values(stated.views ?? {}).includes('absent'));
    some((stated) => stated.model !== undefined && 'reply' in stated.model);
    some((stated) => stated.model !== undefined && 'fails' in stated.model);
    some((stated) => stated.model !== undefined && stated.model.shown.length === 20);
    some((stated) => stated.request.useSemanticScoring === false);
    some((stated) => stated.request.limit !== undefined);
  });

  it('holds every request and every resource to its schema', () => {
    for (const stated of table.cases) {
      const request = validators.MatchSearchRequest(stated.request);
      expect(request, `${stated.why}: ${formatErrors(validators.MatchSearchRequest.errors)}`).toBe(true);
      for (const resource of stated.resources) {
        const valid = validators.ResourceDescriptor(resource);
        expect(valid, `${stated.why}: ${formatErrors(validators.ResourceDescriptor.errors)}`).toBe(true);
      }
    }
  });

  it.each(table.cases)('$why', async (stated) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(stated.now));

    const { stores, embedding, model, asked } = world(stated);
    const bus = new EventBus();
    const matcher = new Matcher(stores, bus, silentLogger, model, embedding);
    await matcher.initialize();

    try {
      const reply = firstValueFrom(merge(
        bus.on('match:search-results').pipe(map((payload) => ({ channel: 'match:search-results', payload }))),
        bus.on('match:search-failed').pipe(map((payload) => ({ channel: 'match:search-failed', payload }))),
      ));
      bus.emit('match:search-requested', stated.request, { correlationId: 'score-cases' });
      const answered = await reply;

      const { referenceId } = stated.request;

      if (stated.results === undefined) {
        expect(answered).toEqual({ channel: 'match:search-failed', payload: { referenceId, error: stated.failed } });
        // A failed search is held to its reply, and to having asked no source
        // the case does not state.
        if (stated.graph.byName === undefined) expect(asked.byName).toEqual([]);
        if (stated.graph.byEntityType === undefined) expect(asked.byEntityType).toEqual([]);
        if (stated.graph.byId === undefined) expect(asked.graphIds).toEqual([]);
        if (stated.views === undefined) expect(asked.viewIds).toEqual([]);
        if (stated.vectors === undefined) expect(asked.vectorSearches).toEqual([]);
        if (stated.model === undefined) expect(asked.prompts).toEqual([]);
        return;
      }

      const described = new Map(stated.resources.map((resource) => [String(resource['@id']), resource]));
      expect(answered).toEqual({
        channel: 'match:search-results',
        payload: {
          referenceId,
          response: stated.results.map(({ id, score, matchReason }) => ({ ...described.get(id), score, matchReason })),
        },
      });
      const valid = validators.MatchSearchResult(answered.payload);
      expect(valid, formatErrors(validators.MatchSearchResult.errors)).toBe(true);

      // What each source was asked.
      expect(asked.byName).toEqual([{ search: stated.term, limit: 20 }]);
      expect(asked.byEntityType).toEqual(
        stated.graph.byEntityType === undefined
          ? []
          : [{ entityTypes: stated.request.context.metadata.entityTypes, limit: 50 }],
      );
      expect(distinct(asked.graphIds)).toEqual(Object.keys(stated.graph.byId ?? {}).sort());
      expect(distinct(asked.viewIds)).toEqual(Object.keys(stated.views ?? {}).sort());
      expect(asked.embedded).toEqual(stated.vectors === undefined ? [] : [stated.term]);
      expect(asked.vectorSearches).toEqual(stated.vectors === undefined ? [] : [{ limit: 40, scoreThreshold: 0.4 }]);
      expect(asked.prompts.map(shownIn)).toEqual(stated.model === undefined ? [] : [stated.model.shown]);
    } finally {
      await matcher.stop();
      bus.destroy();
    }
  });
});
