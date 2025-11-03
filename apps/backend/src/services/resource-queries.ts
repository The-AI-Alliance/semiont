/**
 * Layer 3: Resource Query Service
 *
 * Reads resource metadata from projection storage (Layer 3)
 * Does NOT touch the graph - graph is only for traversals
 *
 * Uses ProjectionManager as single source of truth for paths
 */

import { getFilesystemConfig } from '../config/environment-loader';
import { createProjectionManager } from './storage-service';
import type { components } from '@semiont/api-client';
import { resourceId as makeResourceId } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface ListResourcesFilters {
  search?: string;
  archived?: boolean;
}

export class ResourceQueryService {
  /**
   * Get resource metadata from Layer 3 projection
   */
  static async getResourceMetadata(resourceId: string): Promise<ResourceDescriptor | null> {
    const config = getFilesystemConfig();
    const basePath = config.path;

    // Use ProjectionManager to get projection (respects configured subNamespace)
    const projectionManager = createProjectionManager(basePath, {
      subNamespace: 'resources',
    });

    const state = await projectionManager.get(makeResourceId(resourceId));
    if (!state) {
      return null;
    }

    return state.resource;
  }

  /**
   * List all resources by scanning Layer 3 projection files
   */
  static async listResources(filters?: ListResourcesFilters): Promise<ResourceDescriptor[]> {
    const config = getFilesystemConfig();
    const basePath = config.path;

    // Use ProjectionManager to get all resources (respects configured subNamespace)
    const projectionManager = createProjectionManager(basePath, {
      subNamespace: 'resources',
    });

    const allStates = await projectionManager.getAll();
    const resources: ResourceDescriptor[] = [];

    for (const state of allStates) {
      const doc = state.resource;

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
}
