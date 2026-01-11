/**
 * Graph Context
 *
 * Provides graph database operations for resources and annotations.
 * All methods require graph traversal - must use graph database.
 */

import { getGraphDatabase } from '@semiont/graph';
import { resourceIdToURI } from '@semiont/core';
import type {
  ResourceId,
  EnvironmentConfig,
  GraphConnection,
  GraphPath,
} from '@semiont/core';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export class GraphContext {
  /**
   * Get all resources referencing this resource (backlinks)
   * Requires graph traversal - must use graph database
   */
  static async getBacklinks(resourceId: ResourceId, config: EnvironmentConfig): Promise<Annotation[]> {
    const graphDb = await getGraphDatabase(config);
    const resourceUri = resourceIdToURI(resourceId, config.services.backend!.publicURL);
    return await graphDb.getResourceReferencedBy(resourceUri);
  }

  /**
   * Find shortest path between two resources
   * Requires graph traversal - must use graph database
   */
  static async findPath(
    fromResourceId: ResourceId,
    toResourceId: ResourceId,
    config: EnvironmentConfig,
    maxDepth?: number
  ): Promise<GraphPath[]> {
    const graphDb = await getGraphDatabase(config);
    return await graphDb.findPath(fromResourceId, toResourceId, maxDepth);
  }

  /**
   * Get resource connections (graph edges)
   * Requires graph traversal - must use graph database
   */
  static async getResourceConnections(resourceId: ResourceId, config: EnvironmentConfig): Promise<GraphConnection[]> {
    const graphDb = await getGraphDatabase(config);
    return await graphDb.getResourceConnections(resourceId);
  }

  /**
   * Search resources by name (cross-resource query)
   * Requires full-text search - must use graph database
   */
  static async searchResources(query: string, config: EnvironmentConfig, limit?: number): Promise<ResourceDescriptor[]> {
    const graphDb = await getGraphDatabase(config);
    return await graphDb.searchResources(query, limit);
  }
}
