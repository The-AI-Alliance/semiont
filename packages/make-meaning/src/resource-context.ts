/**
 * Resource Context
 *
 * Assembles resource context from view storage and content store.
 * Graph queries go through GraphContext — with one deliberate exception:
 * `listResources`' search path runs inside the graph engine, and its
 * semantic fallback reads the vector index. Both are single-index reads;
 * anything that FUSES sources belongs to the Matcher.
 */

import { decodeRepresentation, derivesTextOf, getResourceEntityTypes, getResourceId, textSourceOf } from '@semiont/core';
import { representationSource } from './representation.js';
import type { AnchoredTextAsk } from './anchored-text-ask.js';
import type { ResourceId } from '@semiont/core';
import { compareByRecencyThenId, type GraphDatabase } from '@semiont/graph';
import type { VectorStore } from '@semiont/vectors';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { ContentReads, WorkingTreeStore } from '@semiont/content';
import { searchResources, type SemanticFallbackDeps } from './resource-search';

import type { ResourceDescriptor } from '@semiont/core';

/** What the listing paths read: lexical search in the graph, unsearched
 *  listings from views, the semantic fallback in the vector index — plus
 *  `resourceWithViewGrace`'s graph-first hydration. */
export interface ListResourcesReads {
  views: Pick<ViewStorage, 'get' | 'getAll'>;
  graph: Pick<GraphDatabase, 'listResources' | 'getResource'>;
  vectors: Pick<VectorStore, 'searchResources'>;
}

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
   * Which kind of answer this is: 'lexical' for the graph/view paths
   * (including an honestly-empty page), 'semantic' when an empty lexical
   * search was answered from the vector index. REQUIRED — an optional
   * discriminator defaulting to lexical would let a missing value silently
   * read as lexical.
   */
  matchKind: 'lexical' | 'semantic';
}

export class ResourceContext {
  /**
   * Get resource metadata from view storage
   */
  static async getResourceMetadata(resourceId: ResourceId, kb: { views: Pick<ViewStorage, 'get'> }): Promise<ResourceDescriptor | null> {
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
    kb: ListResourcesReads,
    semantic: SemanticFallbackDeps,
  ): Promise<ListResourcesResult> {
    const { search: rawSearch, archived, entityType, offset = 0, limit = 50 } = filters ?? {};
    // Blank input is not a search: it must not divert the listing onto the
    // eventually-consistent graph path, and it has nothing to match on.
    const search = rawSearch?.trim() || undefined;

    // A search has one implementation, the Librarian's
    // (`match:resources-requested`); a searched listing reaches it here.
    if (search) return searchResources({ search, archived, entityType, offset, limit }, kb, semantic);

    const allViews = await kb.views.getAll();
    const matches = allViews
      .map((view) => view.resource)
      .filter((doc) => archived === undefined || doc.archived === archived)
      .filter((doc) => !entityType || getResourceEntityTypes(doc).includes(entityType))
      .sort(compareByRecencyThenId);

    return { resources: matches.slice(offset, offset + limit), total: matches.length, matchKind: 'lexical' };
  }

  /**
   * Add content previews to resources (for search results)
   * Retrieves and decodes the first 200 characters of each resource's primary representation
   */
  static async addContentPreviews(
    resources: ResourceDescriptor[],
    kb: { content: Pick<WorkingTreeStore, 'retrieve'> }
  ): Promise<Array<ResourceDescriptor & { content: string }>> {
    return Promise.all(
      resources.map(async (doc) => {
        try {
          // The descriptors are already in hand, so this takes the descriptor
          // half of the one resolution rather than re-reading the view.
          // Previews exist only for decode media: a binary row would
          // preview 200 chars of mojibake.
          const source = representationSource(doc);
          if (source && !derivesTextOf(source.mediaType) && textSourceOf(source.mediaType) !== 'none') {
            const contentBuffer = await kb.content.retrieve(source.storageUri);
            const contentPreview = decodeRepresentation(contentBuffer, source.mediaType).slice(0, 200);
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
   * Get full content for a resource, as TEXT — the read-side dispatcher
   * (utf-8-decoding a PDF's raw bytes would ship them to inference as
   * text): the media type decides where the text comes from, exactly as
   * it decides who may derive it.
   *
   * - `decode`         — the bytes ARE the text: fetch (ResourceId-keyed)
   *                      and charset-decode.
   * - derived (`derivesTextOf`) — the text is the Smelter's artifact: the
   *                      anchored-text read answers, and its classified
   *                      absences (`not-yet`, `no-map`, `unknown`, a stored
   *                      decline) all mean ABSENT — `undefined`, never `''`
   *                      and never decoded bytes.
   * - `none`           — this media has no text; neither door is touched.
   */
  static async getResourceContent(
    resource: ResourceDescriptor,
    kb: { content: ContentReads; anchoredText: AnchoredTextAsk }
  ): Promise<string | undefined> {
    const id = getResourceId(resource);
    const source = representationSource(resource);
    if (!source || !id) return undefined;

    // Category, not mechanism: a new strategy declares its side in core's
    // exhaustive category maps (`derivesTextOf`), and this dispatch follows
    // automatically — the mechanism literal stays on the extraction side.
    if (textSourceOf(source.mediaType) === 'none') return undefined;
    if (derivesTextOf(source.mediaType)) {
      const answer = await kb.anchoredText(id);
      return answer.kind === 'extracted' ? answer.text : undefined;
    }
    // The bytes are the text. The transport reports the media type it
    // served; the descriptor's is the same fact by construction (both come
    // from the one resolution), so this decodes with what came back rather
    // than re-deriving it.
    const { data, contentType } = await kb.content.getBinary(id);
    return decodeRepresentation(Buffer.from(data), contentType);
  }
}
