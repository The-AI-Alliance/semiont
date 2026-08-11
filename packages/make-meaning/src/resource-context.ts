/**
 * Resource Context
 *
 * Assembles resource context from view storage and content store.
 * Graph queries go through GraphContext — with one deliberate exception:
 * `listResources`' search path runs inside the graph engine, and its
 * semantic fallback (SEMANTIC-FALLBACK) reads the vector index. Both are
 * single-index reads; anything that FUSES sources belongs to the Matcher.
 */

import { getPrimaryRepresentation, decodeRepresentation, getResourceEntityTypes } from '@semiont/core';
import type { Logger, ResourceId } from '@semiont/core';
import { compareByRecencyThenId } from '@semiont/graph';
import { mergeByResource, type EmbeddingProvider } from '@semiont/vectors';
import type { KnowledgeBase } from './knowledge-base';
import { resourceWithViewGrace } from './graph-read-grace';

import type { ResourceDescriptor } from '@semiont/core';

export interface ListResourcesFilters {
  search?: string;
  archived?: boolean;
  entityType?: string;
  offset?: number;
  limit?: number;
}

export interface ListResourcesResult {
  /** Semantic hits carry `content` — the passage that matched, not a preview. */
  resources: Array<ResourceDescriptor & { content?: string }>;
  /** Size of the whole match set, not of the returned page. */
  total: number;
  /**
   * Which kind of answer this is (SEMANTIC-FALLBACK): 'lexical' for the
   * graph/view paths (including an honestly-empty page), 'semantic' when an
   * empty lexical search was answered from the vector index. REQUIRED — an
   * optional discriminator defaulting to lexical would let a missing value
   * silently read as lexical.
   */
  matchKind: 'lexical' | 'semantic';
}

/**
 * What the semantic fallback needs, passed as plain arguments (the
 * buildContext idiom — providers are parameters, not fields). `embeddingProvider`
 * is undefined when vectors/embedding are unconfigured; the fallback then
 * degrades to the empty lexical page (axioms S3/S4).
 */
export interface SemanticFallbackDeps {
  embeddingProvider: EmbeddingProvider | undefined;
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

export class ResourceContext {
  /**
   * Get resource metadata from view storage
   */
  static async getResourceMetadata(resourceId: ResourceId, kb: KnowledgeBase): Promise<ResourceDescriptor | null> {
    const view = await kb.views.get(resourceId);
    if (!view) {
      return null;
    }

    return view.resource;
  }

  /**
   * List resources, optionally filtered, as one page plus the size of the whole
   * match set. Every filter is applied before pagination on both paths — a
   * filter applied afterwards narrows the page rather than the match set, which
   * is how a search scoped to an entity type can come back empty while hundreds
   * of resources match.
   *
   * When `search` is set, the entire query — filtering, ordering and
   * pagination — runs inside the graph engine.
   *
   * When `search` is unset, the materialized views answer instead. They are the
   * barrier-stamped projection, so an unsearched listing is read-your-writes
   * where the graph is only eventually consistent.
   */
  static async listResources(
    filters: ListResourcesFilters | undefined,
    kb: KnowledgeBase,
    semantic?: SemanticFallbackDeps,
  ): Promise<ListResourcesResult> {
    const { search: rawSearch, archived, entityType, offset = 0, limit = 50 } = filters ?? {};
    // Blank input is not a search: it must not divert the listing onto the
    // eventually-consistent graph path, and it has nothing to match on.
    const search = rawSearch?.trim() || undefined;

    if (search) {
      // Set-shaped graph read — eventually consistent BY DESIGN
      // (graph-read-after-write-coverage.md, mechanism (d)): no key to
      // await, human-timescale browse; a just-created resource appears in
      // search after the Weaver's ~tens-of-ms apply.
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
      return ResourceContext.semanticFallback(search, limit, kb, semantic);
    }

    const allViews = await kb.views.getAll();
    const matches = allViews
      .map((view) => view.resource)
      .filter((doc) => archived === undefined || doc.archived === archived)
      .filter((doc) => !entityType || getResourceEntityTypes(doc).includes(entityType))
      .sort(compareByRecencyThenId);

    return { resources: matches.slice(offset, offset + limit), total: matches.length, matchKind: 'lexical' };
  }

  /**
   * Answer an empty lexical search from the vector index (SEMANTIC-FALLBACK):
   * embed the query once, fold chunk hits per resource, floor them, and label
   * the answer 'semantic' so the UI can say "no title matches, but these
   * documents discuss it".
   *
   * Degradation is the contract (axioms S3–S5): unconfigured vectors, an
   * absent provider, or ANY failure inside the fallback yields the same
   * empty page the caller already had, labelled 'lexical' — a broken
   * fallback must never turn a working empty search into an error.
   *
   * The floor is applied HERE rather than passed as `scoreThreshold`, so the
   * below-floor hits exist to be counted — the debug line is the evidence
   * decision #1's guessed 0.6 gets tuned from.
   */
  private static async semanticFallback(
    search: string,
    limit: number,
    kb: KnowledgeBase,
    semantic: SemanticFallbackDeps | undefined,
  ): Promise<ListResourcesResult> {
    const empty: ListResourcesResult = { resources: [], total: 0, matchKind: 'lexical' };
    if (!semantic?.embeddingProvider || !kb.vectors) return empty;

    try {
      const embedding = await semantic.embeddingProvider.embed(search);
      const hits = await kb.vectors.searchResources(embedding, { limit: limit * SEMANTIC_OVER_FETCH });
      const merged = mergeByResource(hits);
      const aboveFloor = merged.filter((h) => h.score >= semantic.semanticFloor);
      // The tuning evidence (decision #1) — one line per fallback.
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
   * Add content previews to resources (for search results)
   * Retrieves and decodes the first 200 characters of each resource's primary representation
   */
  static async addContentPreviews(
    resources: ResourceDescriptor[],
    kb: KnowledgeBase
  ): Promise<Array<ResourceDescriptor & { content: string }>> {
    return Promise.all(
      resources.map(async (doc) => {
        try {
          if (doc.storageUri) {
            const contentBuffer = await kb.content.retrieve(doc.storageUri);
            const primaryRep = getPrimaryRepresentation(doc);
            const contentPreview = decodeRepresentation(contentBuffer, primaryRep?.mediaType ?? 'text/plain').slice(0, 200);
            return { ...doc, content: contentPreview };
          }
          return { ...doc, content: '' };
        } catch {
          return { ...doc, content: '' };
        }
      })
    );
  }

  /**
   * Get full content for a resource
   * Retrieves and decodes the primary representation
   */
  static async getResourceContent(
    resource: ResourceDescriptor,
    kb: KnowledgeBase
  ): Promise<string | undefined> {
    if (resource.storageUri) {
      const contentBuffer = await kb.content.retrieve(resource.storageUri);
      const primaryRep = getPrimaryRepresentation(resource);
      return decodeRepresentation(contentBuffer, primaryRep?.mediaType ?? 'text/plain');
    }
    return undefined;
  }
}
