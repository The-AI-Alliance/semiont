/**
 * Resource Context
 *
 * Assembles resource context from view storage and content store
 * Does NOT touch the graph - graph queries go through GraphContext
 */

import { getPrimaryRepresentation, decodeRepresentation } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';

import type { ResourceDescriptor } from '@semiont/core';

export interface ListResourcesFilters {
  search?: string;
  archived?: boolean;
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
   * List resources, optionally filtered.
   *
   * When `search` is set, delegates to `kb.graph.searchResources`, which runs
   * the name match in the graph engine instead of scanning every view in JS.
   * The graph result is then narrowed by `archived` if requested.
   *
   * When `search` is unset, falls back to scanning all materialized views.
   * (TODO: also push the listing path through the graph for large KBs.)
   */
  static async listResources(filters: ListResourcesFilters | undefined, kb: KnowledgeBase): Promise<ResourceDescriptor[]> {
    if (filters?.search) {
      const matches = await kb.graph.searchResources(filters.search);
      const filtered = filters.archived !== undefined
        ? matches.filter((doc) => doc.archived === filters.archived)
        : matches;
      return ResourceContext.sortByDateDesc(filtered);
    }

    const allViews = await kb.views.getAll();
    const resources: ResourceDescriptor[] = [];

    for (const view of allViews) {
      const doc = view.resource;
      if (filters?.archived !== undefined && doc.archived !== filters.archived) {
        continue;
      }
      resources.push(doc);
    }

    return ResourceContext.sortByDateDesc(resources);
  }

  private static sortByDateDesc(resources: ResourceDescriptor[]): ResourceDescriptor[] {
    return [...resources].sort((a, b) => {
      const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
      const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
      return bTime - aTime;
    });
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
