/**
 * Annotation Query Service
 *
 * Optimized read path for resource annotations
 * - Single-resource queries use filesystem view storage
 * - Graph queries use graph database
 */

import { FilesystemViewStorage } from '../storage/view-storage';
import { getGraphDatabase } from '../graph/factory';
import type { components } from '@semiont/api-client';
import type {
  ResourceAnnotations,
  ResourceId,
  AnnotationId,
  AnnotationCategory,
  EnvironmentConfig,
  GraphConnection,
  GraphPath,
} from '@semiont/core';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export class AnnotationQueryService {
  /**
   * Get resource annotations from view storage (fast path)
   * Throws if view missing
   */
  static async getResourceAnnotations(resourceId: ResourceId, config: EnvironmentConfig): Promise<ResourceAnnotations> {
    if (!config.services?.filesystem?.path) {
      throw new Error('Filesystem path not found in configuration');
    }
    const basePath = config.services.filesystem.path;
    const projectRoot = config._metadata?.projectRoot;
    const viewStorage = new FilesystemViewStorage(basePath, projectRoot);
    const view = await viewStorage.get(resourceId);

    if (!view) {
      throw new Error(`Resource ${resourceId} not found in view storage`);
    }

    return view.annotations;
  }

  /**
   * Get all annotations
   * @returns Array of all annotation objects
   */
  static async getAllAnnotations(resourceId: ResourceId, config: EnvironmentConfig): Promise<Annotation[]> {
    const annotations = await this.getResourceAnnotations(resourceId, config);
    return annotations.annotations;
  }

  /**
   * Get resource stats (version info)
   * @returns Version and timestamp info for the annotations
   */
  static async getResourceStats(resourceId: ResourceId, config: EnvironmentConfig): Promise<{
    resourceId: ResourceId;
    version: number;
    updatedAt: string;
  }> {
    const annotations = await this.getResourceAnnotations(resourceId, config);
    return {
      resourceId: annotations.resourceId,
      version: annotations.version,
      updatedAt: annotations.updatedAt,
    };
  }

  /**
   * Check if resource exists in view storage
   */
  static async resourceExists(resourceId: ResourceId, config: EnvironmentConfig): Promise<boolean> {
    if (!config.services?.filesystem?.path) {
      throw new Error('Filesystem path not found in configuration');
    }
    const basePath = config.services.filesystem.path;
    const projectRoot = config._metadata?.projectRoot;
    const viewStorage = new FilesystemViewStorage(basePath, projectRoot);
    return await viewStorage.exists(resourceId);
  }

  /**
   * Get a single annotation by ID
   * O(1) lookup using resource ID to access view storage
   */
  static async getAnnotation(annotationId: AnnotationId, resourceId: ResourceId, config: EnvironmentConfig): Promise<Annotation | null> {
    const annotations = await this.getResourceAnnotations(resourceId, config);
    // Extract short ID from annotation's full URI for comparison
    return annotations.annotations.find((a: Annotation) => {
      const shortId = a.id.split('/').pop();
      return shortId === annotationId;
    }) || null;
  }

  /**
   * List annotations with optional filtering
   * @param filters - Optional filters like resourceId and type
   * @throws Error if resourceId not provided (cross-resource queries not supported in view storage)
   */
  static async listAnnotations(filters: { resourceId?: ResourceId; type?: AnnotationCategory } | undefined, config: EnvironmentConfig): Promise<Annotation[]> {
    if (!filters?.resourceId) {
      throw new Error('resourceId is required for annotation listing - cross-resource queries not supported in view storage');
    }

    // Use view storage directly
    return await this.getAllAnnotations(filters.resourceId, config);
  }

  // ========================================
  // Graph Queries (Graph Database)
  // ========================================

  /**
   * Get all resources referencing this resource (backlinks)
   * Requires graph traversal - must use graph database
   */
  static async getBacklinks(resourceId: ResourceId, config: EnvironmentConfig): Promise<Annotation[]> {
    const graphDb = await getGraphDatabase(config);
    return await graphDb.getResourceReferencedBy(resourceId);
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