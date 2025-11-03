/**
 * Annotation Query Service
 *
 * Optimized read path for resource annotations
 * - Single-resource queries use Layer 3 (filesystem projections)
 * - Graph queries use Layer 4 (graph database)
 */

import { createProjectionManager } from './storage-service';
import { getGraphDatabase } from '../graph/factory';
import type { components } from '@semiont/api-client';
import type { ResourceAnnotations, ResourceId, AnnotationId, AnnotationCategory } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import { getFilesystemConfig } from '../config/environment-loader';

type Annotation = components['schemas']['Annotation'];

export class AnnotationQueryService {
  /**
   * Get resource annotations from Layer 3 (fast path)
   * Falls back to GraphDB if projection missing
   */
  static async getResourceAnnotations(resourceId: string): Promise<ResourceAnnotations> {
    const basePath = getFilesystemConfig().path;
    const projectionManager = createProjectionManager(basePath);
    const stored = await projectionManager.get(resourceId);

    if (!stored) {
      throw new Error(`Resource ${resourceId} not found in Layer 3 projections`);
    }

    return stored.annotations;
  }

  /**
   * Get all annotations
   * @returns Array of all annotation objects
   */
  static async getAllAnnotations(resourceId: string): Promise<Annotation[]> {
    const annotations = await this.getResourceAnnotations(resourceId);
    return annotations.annotations;
  }

  /**
   * Get resource stats (version info)
   * @returns Version and timestamp info for the annotations
   */
  static async getResourceStats(resourceId: string): Promise<{
    resourceId: string;
    version: number;
    updatedAt: string;
  }> {
    const annotations = await this.getResourceAnnotations(resourceId);
    return {
      resourceId: annotations.resourceId,
      version: annotations.version,
      updatedAt: annotations.updatedAt,
    };
  }

  /**
   * Check if resource exists in Layer 3
   */
  static async resourceExists(resourceId: string): Promise<boolean> {
    const basePath = getFilesystemConfig().path;
    const projectionManager = createProjectionManager(basePath);
    return await projectionManager.exists(resourceId);
  }

  /**
   * Get a single annotation by ID
   * O(1) lookup using resource ID to access Layer 3 projection
   */
  static async getAnnotation(annotationId: AnnotationId, resourceId: ResourceId): Promise<Annotation | null> {
    const annotations = await this.getResourceAnnotations(resourceId);
    return annotations.annotations.find(a => a.id === annotationId) || null;
  }

  /**
   * List annotations with optional filtering
   * @param filters - Optional filters like resourceId and type
   */
  static async listAnnotations(filters?: { resourceId?: string; type?: AnnotationCategory }): Promise<any> {
    if (filters?.resourceId) {
      // If filtering by resource ID, use Layer 3 directly
      return await this.getAllAnnotations(filters.resourceId);
    }

    // For now, fall back to graph for cross-resource listing
    // TODO: Implement by scanning all projections
    const graphDb = await getGraphDatabase();
    const graphFilters = filters?.resourceId
      ? { resourceId: makeResourceId(filters.resourceId), type: filters.type }
      : { type: filters?.type };
    const result = await graphDb.listAnnotations(graphFilters);
    return result.annotations || [];
  }

  // ========================================
  // Graph Queries (Layer 4 only)
  // ========================================

  /**
   * Get all resources referencing this resource (backlinks)
   * Requires graph traversal - must use Layer 4
   */
  static async getBacklinks(resourceId: string): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.getResourceReferencedBy(makeResourceId(resourceId));
  }

  /**
   * Find shortest path between two resources
   * Requires graph traversal - must use Layer 4
   */
  static async findPath(
    fromResourceId: string,
    toResourceId: string,
    maxDepth?: number
  ): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.findPath(makeResourceId(fromResourceId), makeResourceId(toResourceId), maxDepth);
  }

  /**
   * Get resource connections (graph edges)
   * Requires graph traversal - must use Layer 4
   */
  static async getResourceConnections(resourceId: string): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.getResourceConnections(makeResourceId(resourceId));
  }

  /**
   * Search resources by name (cross-resource query)
   * Requires full-text search - must use Layer 4
   */
  static async searchResources(query: string, limit?: number): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.searchResources(query, limit);
  }
}