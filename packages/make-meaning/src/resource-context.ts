/**
 * Resource Context
 *
 * Assembles resource context from view storage and content store
 * Does NOT touch the graph - graph queries go through GraphContext
 */

import { getPrimaryRepresentation, decodeRepresentation, getResourceEntityTypes } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import { compareByRecencyThenId } from '@semiont/graph';
import type { KnowledgeBase } from './knowledge-base';

import type { ResourceDescriptor } from '@semiont/core';

export interface ListResourcesFilters {
  search?: string;
  archived?: boolean;
  entityType?: string;
  offset?: number;
  limit?: number;
}

export interface ListResourcesResult {
  resources: ResourceDescriptor[];
  /** Size of the whole match set, not of the returned page. */
  total: number;
}

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
  static async listResources(filters: ListResourcesFilters | undefined, kb: KnowledgeBase): Promise<ListResourcesResult> {
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 50;

    if (filters?.search) {
      // Set-shaped graph read — eventually consistent BY DESIGN
      // (graph-read-after-write-coverage.md, mechanism (d)): no key to
      // await, human-timescale browse; a just-created resource appears in
      // search after the Weaver's ~tens-of-ms apply.
      return kb.graph.listResources({
        search: filters.search,
        archived: filters.archived,
        entityTypes: filters.entityType ? [filters.entityType] : undefined,
        offset,
        limit,
      });
    }

    const allViews = await kb.views.getAll();
    const matches = allViews
      .map((view) => view.resource)
      .filter((doc) => filters?.archived === undefined || doc.archived === filters.archived)
      .filter((doc) => !filters?.entityType || getResourceEntityTypes(doc).includes(filters.entityType))
      .sort(compareByRecencyThenId);

    return { resources: matches.slice(offset, offset + limit), total: matches.length };
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
