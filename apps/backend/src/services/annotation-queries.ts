/**
 * Annotation Query Service
 *
 * Optimized read path for resource annotations
 * - Single-resource queries use filesystem view storage
 * - Graph queries use graph database
 */

import { FilesystemViewStorage } from '../storage/view-storage';
import { getGraphDatabase } from '../graph/factory';
import { resourceIdToURI } from '@semiont/api-client';
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

    // Enrich resolved references with document names
    // NOTE: Future optimization - make this optional via query param if performance becomes an issue
    return await this.enrichResolvedReferences(annotations.annotations, config);
  }

  /**
   * Enrich reference annotations with resolved document names
   * Adds _resolvedDocumentName property to annotations that link to documents
   * @private
   */
  private static async enrichResolvedReferences(annotations: Annotation[], config: EnvironmentConfig): Promise<Annotation[]> {
    if (!config.services?.filesystem?.path) {
      return annotations;
    }

    // Extract unique resolved document URIs from reference annotations
    const resolvedUris = new Set<string>();
    for (const ann of annotations) {
      if (ann.motivation === 'linking' && ann.body) {
        const body = Array.isArray(ann.body) ? ann.body : [ann.body];
        for (const item of body) {
          if (item.purpose === 'linking' && item.source) {
            resolvedUris.add(item.source);
          }
        }
      }
    }

    if (resolvedUris.size === 0) {
      return annotations;
    }

    // Batch fetch all resolved documents in parallel
    const basePath = config.services.filesystem.path;
    const projectRoot = config._metadata?.projectRoot;
    const viewStorage = new FilesystemViewStorage(basePath, projectRoot);

    const metadataPromises = Array.from(resolvedUris).map(async (uri) => {
      const docId = uri.split('/resources/')[1];
      if (!docId) return null;

      try {
        const view = await viewStorage.get(docId as ResourceId);
        if (view?.resource?.name) {
          return {
            uri,
            metadata: {
              name: view.resource.name,
              mediaType: view.resource.mediaType as string | undefined
            }
          };
        }
      } catch (e) {
        // Document might not exist, skip
      }
      return null;
    });

    const results = await Promise.all(metadataPromises);
    const uriToMetadata = new Map<string, { name: string; mediaType?: string }>();
    for (const result of results) {
      if (result) {
        uriToMetadata.set(result.uri, result.metadata);
      }
    }

    // Add _resolvedDocumentName and _resolvedDocumentMediaType to annotations
    return annotations.map(ann => {
      if (ann.motivation === 'linking' && ann.body) {
        const body = Array.isArray(ann.body) ? ann.body : [ann.body];
        for (const item of body) {
          if (item.purpose === 'linking' && item.source) {
            const metadata = uriToMetadata.get(item.source);
            if (metadata) {
              return {
                ...ann,
                _resolvedDocumentName: metadata.name,
                _resolvedDocumentMediaType: metadata.mediaType
              } as Annotation;
            }
          }
        }
      }
      return ann;
    });
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