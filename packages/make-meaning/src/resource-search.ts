/**
 * Resource Search
 *
 * Searching the knowledge base's resources by text: lexically in the graph,
 * and by meaning in the vector index when nothing matches lexically. Both
 * are single-index reads; anything that FUSES sources belongs to the
 * Matcher's reference search.
 *
 * This is retrieval, so the Librarian answers it (`match:resources-requested`).
 * A listing with no search is the record's, answered from views by the
 * Archivist (`ResourceContext.listResources`).
 */

import { decodeRepresentation, derivesTextOf, getResourceId, resourceId as makeResourceId, textSourceOf } from '@semiont/core';
import type { Logger, ResourceDescriptor } from '@semiont/core';
import type { GraphDatabase } from '@semiont/graph';
import { mergeByResource, type EmbeddingProvider, type VectorStore } from '@semiont/vectors';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { ContentReads } from '@semiont/content';
import { representationSource } from './representation.js';
import { resourceWithViewGrace } from './graph-read-grace';

/** What a search reads: lexical matches in the graph, the semantic fallback
 *  in the vector index, and `resourceWithViewGrace`'s graph-first hydration. */
export interface ResourceSearchReads {
  graph: Pick<GraphDatabase, 'listResources' | 'getResource'>;
  views: Pick<ViewStorage, 'get'>;
  vectors: Pick<VectorStore, 'searchResources'>;
}

export interface ResourceSearchFilters {
  search: string;
  archived?: boolean;
  entityType?: string;
  offset?: number;
  limit?: number;
}

export interface ResourceSearchResult {
  /** Semantic hits carry `content` — the passage that matched, not a preview. */
  resources: Array<ResourceDescriptor & { content?: string }>;
  /** Size of the whole match set, not of the returned page. */
  total: number;
  /**
   * Which kind of answer this is: 'lexical' for the graph's (including an
   * honestly-empty page), 'semantic' when an empty lexical search was
   * answered from the vector index. REQUIRED — an optional discriminator
   * defaulting to lexical would let a missing value silently read as
   * lexical.
   */
  matchKind: 'lexical' | 'semantic';
}

/**
 * What the semantic fallback needs, passed as plain arguments (the
 * buildContext idiom — providers are parameters, not fields). Both the
 * provider and `kb.vectors` are mandatory, so there is no unconfigured
 * branch. What degrades is FAILURE: a throwing embed yields the empty
 * lexical page (axiom S5), because mandatory does not mean always up.
 */
export interface SemanticFallbackDeps {
  embeddingProvider: EmbeddingProvider;
  /** Minimum cosine score for a hit to appear — `search.semanticFloor`. */
  semanticFloor: number;
  logger: Logger;
}

/**
 * Chunk-hit over-fetch factor: `searchResources` returns per-chunk hits and
 * the fold collapses them per resource, so a multi-chunk document could
 * otherwise crowd resources out of the page. Headroom, not a guarantee —
 * the same rationale as the vectors package's SEARCH_BY_RESOURCE_OVER_FETCH.
 */
const SEMANTIC_OVER_FETCH = 4;

/**
 * One page of the resources a text search finds, plus the size of the whole
 * match set. The entire lexical query — filtering, ordering and pagination —
 * runs inside the graph engine, so every filter is applied before
 * pagination: a filter applied afterwards narrows the page rather than the
 * match set, which is how a search scoped to an entity type can come back
 * empty while hundreds of resources match.
 */
export async function searchResources(
  filters: ResourceSearchFilters,
  kb: ResourceSearchReads,
  semantic: SemanticFallbackDeps,
): Promise<ResourceSearchResult> {
  const { archived, entityType, offset = 0, limit = 50 } = filters;
  // Blank text has nothing to match on: it finds nothing, and asks no store.
  const search = filters.search.trim();
  if (!search) return { resources: [], total: 0, matchKind: 'lexical' };

  // Set-shaped graph read — eventually consistent BY DESIGN: no key
  // to await, human-timescale browse; a just-created resource appears
  // in search after the Weaver's ~tens-of-ms apply.
  const lexical = await kb.graph.listResources({
    search,
    archived,
    entityTypes: entityType ? [entityType] : undefined,
    offset,
    limit,
  });
  // The fallback's whole cost model: the embedding call is unreachable
  // unless this page would otherwise be empty (axiom S1), and a later
  // page of an empty search never re-triggers it (S8).
  if (lexical.total > 0 || offset > 0) return { ...lexical, matchKind: 'lexical' };
  return semanticFallback(search, limit, kb, semantic);
}

/**
 * Answer an empty lexical search from the vector index:
 * embed the query once, fold chunk hits per resource, floor them, and label
 * the answer 'semantic' so the UI can say "no title matches, but these
 * documents discuss it".
 *
 * Degradation is the contract (axiom S5): ANY failure inside the
 * fallback yields the same empty page the caller already had, labelled
 * 'lexical' — a broken fallback must never turn a working empty search
 * into an error.
 *
 * The floor is applied HERE rather than passed as `scoreThreshold`, so the
 * below-floor hits exist to be counted — the debug line is the evidence
 * the guessed 0.6 floor gets tuned from.
 */
async function semanticFallback(
  search: string,
  limit: number,
  kb: ResourceSearchReads,
  semantic: SemanticFallbackDeps,
): Promise<ResourceSearchResult> {
  const empty: ResourceSearchResult = { resources: [], total: 0, matchKind: 'lexical' };

  try {
    const embedding = await semantic.embeddingProvider.embed(search);
    const hits = await kb.vectors.searchResources(embedding, { limit: limit * SEMANTIC_OVER_FETCH });
    const merged = mergeByResource(hits);
    const aboveFloor = merged.filter((h) => h.score >= semantic.semanticFloor);
    // The floor's tuning evidence — one line per fallback.
    semantic.logger.debug('[search FALLBACK] semantic score distribution', {
      chunkHits: hits.length,
      resources: merged.length,
      aboveFloor: aboveFloor.length,
      belowFloor: merged.length - aboveFloor.length,
      topScore: merged[0]?.score,
      bottomScore: merged[merged.length - 1]?.score,
      floor: semantic.semanticFloor,
    });

    // Score order is the ranking — recency ordering is the one universal
    // rule this path must NOT apply (axiom S6).
    const resources: Array<ResourceDescriptor & { content?: string }> = [];
    for (const hit of aboveFloor.slice(0, limit)) {
      // Graph-first with view grace: the vector index can momentarily
      // outlive a deleted resource — a hit that hydrates to nothing is
      // dropped, not an error.
      const { resource } = await resourceWithViewGrace(kb, hit.resourceId);
      if (resource) resources.push({ ...resource, content: hit.text });
    }
    return { resources, total: aboveFloor.length, matchKind: 'semantic' };
  } catch (error) {
    semantic.logger.warn('[search FALLBACK] degraded to the empty lexical page', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}

/**
 * Each resource with the first 200 characters of its primary representation,
 * read by resource id — one read per resource, wherever the bytes are.
 *
 * A preview exists only where the bytes ARE the text. Media whose text is
 * derived, or that has none, previews as `''` and no bytes are read:
 * decoding a PDF would preview 200 characters of mojibake. A read that
 * fails previews as `''` too — a preview is a garnish on a hit that is
 * already an answer.
 */
export async function withContentPreviews(
  resources: ResourceDescriptor[],
  content: ContentReads,
): Promise<Array<ResourceDescriptor & { content: string }>> {
  return Promise.all(
    resources.map(async (doc) => {
      try {
        const id = getResourceId(doc);
        const source = representationSource(doc);
        if (id && source && !derivesTextOf(source.mediaType) && textSourceOf(source.mediaType) !== 'none') {
          const { data, contentType } = await content.getBinary(makeResourceId(id));
          return { ...doc, content: decodeRepresentation(Buffer.from(data), contentType).slice(0, 200) };
        }
        return { ...doc, content: '' };
      } catch {
        return { ...doc, content: '' };
      }
    }),
  );
}
