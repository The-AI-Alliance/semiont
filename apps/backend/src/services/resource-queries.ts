/**
 * Resource Query Service
 *
 * Reads resource metadata from view storage
 * Does NOT touch the graph - graph is only for traversals
 */

import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { getPrimaryRepresentation, decodeRepresentation } from '@semiont/api-client';
import type { components } from '@semiont/api-client';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface ListResourcesFilters {
  search?: string;
  archived?: boolean;
}

export class ResourceQueryService {
  /**
   * Get resource metadata from view storage
   */
  static async getResourceMetadata(resourceId: ResourceId, config: EnvironmentConfig): Promise<ResourceDescriptor | null> {
    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;

    const viewStorage = new FilesystemViewStorage(basePath, projectRoot);

    const view = await viewStorage.get(resourceId);
    if (!view) {
      return null;
    }

    return view.resource;
  }

  /**
   * List all resources by scanning view storage
   */
  static async listResources(filters: ListResourcesFilters | undefined, config: EnvironmentConfig): Promise<ResourceDescriptor[]> {
    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;

    const viewStorage = new FilesystemViewStorage(basePath, projectRoot);

    const allViews = await viewStorage.getAll();
    const resources: ResourceDescriptor[] = [];

    for (const view of allViews) {
      const doc = view.resource;

      // Apply filters
      if (filters?.archived !== undefined && doc.archived !== filters.archived) {
        continue;
      }

      if (filters?.search) {
        const searchLower = filters.search.toLowerCase();
        if (!doc.name.toLowerCase().includes(searchLower)) {
          continue;
        }
      }

      resources.push(doc);
    }

    // Sort by creation date (newest first)
    resources.sort((a, b) => {
      const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
      const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
      return bTime - aTime;
    });

    return resources;
  }

  /**
   * Add content previews to resources (for search results)
   * Retrieves and decodes the first 200 characters of each resource's primary representation
   */
  static async addContentPreviews(
    resources: ResourceDescriptor[],
    config: EnvironmentConfig
  ): Promise<Array<ResourceDescriptor & { content: string }>> {
    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    return await Promise.all(
      resources.map(async (doc) => {
        try {
          const primaryRep = getPrimaryRepresentation(doc);
          if (primaryRep?.checksum && primaryRep?.mediaType) {
            const contentBuffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
            const contentPreview = decodeRepresentation(contentBuffer, primaryRep.mediaType).slice(0, 200);
            return { ...doc, content: contentPreview };
          }
          return { ...doc, content: '' };
        } catch {
          return { ...doc, content: '' };
        }
      })
    );
  }
}
