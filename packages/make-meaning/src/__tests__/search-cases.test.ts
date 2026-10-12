/**
 * Searching resources by text, held to specs/src/librarian/search-cases.json:
 * the table every implementation of the Librarian runs, so that what a search
 * asks of each store, the page it answers and what a preview is are stated
 * once and not once per language.
 *
 * Each store is a double that answers what the case states. A store the case
 * does not state fails when asked, and the case fails with it.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validators, formatErrors } from '@semiont/core/openapi';
import type { Logger, ResourceDescriptor, ResourceFilter } from '@semiont/core';
import type { ContentReads } from '@semiont/content';
import type { ResourceView } from '@semiont/event-sourcing';
import type { EmbeddingProvider, VectorSearchResult } from '@semiont/vectors';
import {
  searchResources,
  withContentPreviews,
  type ResourceSearchFilters,
  type ResourceSearchReads,
  type ResourceSearchResult,
} from '../resource-search';

/** What a store answers, or that it fails. */
type Answer<T> = { answers: T } | { fails: true };

interface SearchCase {
  filters: ResourceSearchFilters;
  semanticFloor: number;
  graph?: { asked: ResourceFilter } & Answer<{ resources: ResourceDescriptor[]; total: number }>;
  embedding?: { asked: string } & Answer<number[]>;
  index?: { asked: { embedding: number[]; limit: number } } & Answer<VectorSearchResult[]>;
  hydrated?: Array<{ resource: string; graph: Answer<ResourceDescriptor | null>; view?: Answer<ResourceView | null> }>;
  page?: ResourceSearchResult;
  fails?: true;
}

interface PreviewCase {
  resources: ResourceDescriptor[];
  served: Record<string, { text: string; contentType: string } | { fails: true }>;
  previews: string[];
}

interface Case {
  why: string;
  search?: SearchCase;
  preview?: PreviewCase;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/librarian/search-cases.json', import.meta.url), 'utf8'),
);

const part = <K extends 'search' | 'preview'>(key: K) =>
  table.cases.flatMap((c) => (c[key] ? [{ why: c.why, given: c[key] as NonNullable<Case[K]> }] : []));

const answered = <T>(store: Answer<T>, what: string): Promise<T> =>
  'answers' in store ? Promise.resolve(store.answers) : Promise.reject(new Error(`${what} fails`));

const unstated = (what: string): Error => new Error(`${what} was asked, and the case states no answer of it`);

/** The generated validators the bus runs: a case states no object the bus could not carry. */
function check(schema: 'ResourceDescriptor' | 'ResourceView', value: unknown): string | null {
  const validate = validators[schema];
  return validate(value) ? null : formatErrors(validate.errors);
}

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => silentLogger,
};

function bytesOf(text: string): ArrayBuffer {
  const buffer = Buffer.from(text, 'utf8');
  const data = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(data).set(buffer);
  return data;
}

describe('specs/src/librarian/search-cases.json', () => {
  it('has a case of each of its two parts, and no case of none', () => {
    const parts = ['search', 'preview'] as const;
    for (const key of parts) expect(part(key).length, key).toBeGreaterThan(0);
    for (const c of table.cases) expect(parts.filter((key) => c[key]), c.why).toHaveLength(1);
  });

  describe('a search', () => {
    it.each(part('search'))('$why', async ({ given }) => {
      const hydrated = given.hydrated ?? [];

      for (const resource of given.graph && 'answers' in given.graph ? given.graph.answers.resources : []) {
        expect(check('ResourceDescriptor', resource)).toBeNull();
      }
      for (const { graph, view } of hydrated) {
        if ('answers' in graph && graph.answers) expect(check('ResourceDescriptor', graph.answers)).toBeNull();
        if (view && 'answers' in view && view.answers) expect(check('ResourceView', view.answers)).toBeNull();
      }
      for (const resource of given.page?.resources ?? []) expect(check('ResourceDescriptor', resource)).toBeNull();

      const listResources = vi.fn<ResourceSearchReads['graph']['listResources']>(async () => {
        if (!given.graph) throw unstated('the listing of the graph');
        return answered(given.graph, 'the listing of the graph');
      });
      const getResource = vi.fn<ResourceSearchReads['graph']['getResource']>(async (id) => {
        const entry = hydrated.find(({ resource }) => resource === String(id));
        if (!entry) throw unstated(`the graph, for ${id},`);
        return answered(entry.graph, `the graph, for ${id},`);
      });
      const getView = vi.fn<ResourceSearchReads['views']['get']>(async (id) => {
        const entry = hydrated.find(({ resource }) => resource === String(id));
        if (!entry?.view) throw unstated(`the view of ${id}`);
        return answered(entry.view, `the view of ${id}`);
      });
      const searchIndex = vi.fn<ResourceSearchReads['vectors']['searchResources']>(async () => {
        if (!given.index) throw unstated('the index');
        return answered(given.index, 'the index');
      });
      const embed = vi.fn<EmbeddingProvider['embed']>(async () => {
        if (!given.embedding) throw unstated('the embedding');
        return answered(given.embedding, 'the embedding');
      });
      const embeddingProvider: EmbeddingProvider = { embed, dimensions: vi.fn<EmbeddingProvider['dimensions']>() };

      const search = searchResources(
        given.filters,
        { graph: { listResources, getResource }, views: { get: getView }, vectors: { searchResources: searchIndex } },
        { embeddingProvider, semanticFloor: given.semanticFloor, logger: silentLogger },
      );

      if (given.fails) {
        expect(given.page).toBeUndefined();
        await expect(search).rejects.toThrow();
      } else {
        expect(given.page).toBeDefined();
        expect(await search).toEqual(given.page);
      }

      expect(listResources.mock.calls).toEqual(given.graph ? [[given.graph.asked]] : []);
      expect(embed.mock.calls).toEqual(given.embedding ? [[given.embedding.asked]] : []);
      expect(searchIndex.mock.calls).toEqual(
        given.index ? [[given.index.asked.embedding, { limit: given.index.asked.limit }]] : [],
      );
      expect(getResource.mock.calls.map(([id]) => String(id))).toEqual(hydrated.map(({ resource }) => resource));
      expect(getView.mock.calls.map(([id]) => String(id))).toEqual(
        hydrated.filter(({ view }) => view).map(({ resource }) => resource),
      );
    });
  });

  describe('a preview', () => {
    it.each(part('preview'))('$why', async ({ given }) => {
      for (const resource of given.resources) expect(check('ResourceDescriptor', resource)).toBeNull();

      const getBinary = vi.fn<ContentReads['getBinary']>(async (id) => {
        const served = given.served[String(id)];
        if (!served) throw unstated(`the bytes of ${id}`);
        if ('fails' in served) throw new Error(`the read of ${id} fails`);
        return { data: bytesOf(served.text), contentType: served.contentType };
      });

      const previewed = await withContentPreviews(given.resources, { getBinary });

      expect(previewed).toEqual(given.resources.map((resource, at) => ({ ...resource, content: given.previews[at] })));
      expect(previewed).toHaveLength(given.previews.length);
      expect(getBinary.mock.calls.map(([id]) => String(id))).toEqual(
        given.resources.map((resource) => String(resource['@id'])).filter((id) => Object.hasOwn(given.served, id)),
      );
    });
  });
});
