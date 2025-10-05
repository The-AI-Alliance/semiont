/**
 * Annotation Query Service
 *
 * Optimized read path for document annotations
 * - Single-document queries use Layer 3 (filesystem projections)
 * - Graph queries use Layer 4 (graph database)
 */

import { getProjectionStorage } from '../storage/projection-storage';
import { getGraphDatabase } from '../graph/factory';
import type { DocumentProjection } from '@semiont/core-types';

export class AnnotationQueryService {
  /**
   * Get document annotations from Layer 3 (fast path)
   * Falls back to GraphDB if projection missing
   */
  static async getDocumentAnnotations(documentId: string): Promise<DocumentProjection> {
    const projectionStorage = getProjectionStorage();
    const projection = await projectionStorage.getProjection(documentId);

    if (!projection) {
      throw new Error(`Document ${documentId} not found in Layer 3 projections`);
    }

    return projection;
  }

  /**
   * Get highlights only (subset of projection)
   * @returns Array of highlight objects from projection
   */
  static async getHighlights(documentId: string): Promise<DocumentProjection['highlights']> {
    const projection = await this.getDocumentAnnotations(documentId);
    return projection.highlights;
  }

  /**
   * Get references only (subset of projection)
   * @returns Array of reference objects from projection
   */
  static async getReferences(documentId: string): Promise<DocumentProjection['references']> {
    const projection = await this.getDocumentAnnotations(documentId);
    return projection.references;
  }

  /**
   * Get all selections (highlights + references)
   * @returns Array of all selection objects
   */
  static async getAllSelections(documentId: string): Promise<Array<
    DocumentProjection['highlights'][0] | DocumentProjection['references'][0]
  >> {
    const projection = await this.getDocumentAnnotations(documentId);
    return [...projection.highlights, ...projection.references];
  }

  /**
   * Get document metadata
   * @returns Document metadata without content
   */
  static async getDocumentMetadata(documentId: string): Promise<{
    id: string;
    name: string;
    entityTypes: string[];
    archived: boolean;
    version: number;
    createdAt: string;
    updatedAt: string;
  }> {
    const projection = await this.getDocumentAnnotations(documentId);
    return {
      id: projection.id,
      name: projection.name,
      entityTypes: projection.entityTypes,
      archived: projection.archived,
      version: projection.version,
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
    };
  }

  /**
   * Check if document exists in Layer 3
   */
  static async documentExists(documentId: string): Promise<boolean> {
    const projectionStorage = getProjectionStorage();
    return await projectionStorage.projectionExists(documentId);
  }

  /**
   * Get a single selection (highlight or reference) by ID
   * Scans Layer 3 projections to find the selection
   * O(n) complexity - needs selection ID → document ID index for O(1)
   */
  static async getSelection(selectionId: string): Promise<{
    id: string;
    documentId: string;
    text: string;
    position: { offset: number; length: number };
    type: 'highlight' | 'reference';
    targetDocumentId?: string;
    entityTypes?: string[];
    referenceType?: string;
  } | null> {
    const projectionStorage = getProjectionStorage();
    const allProjections = await projectionStorage.getAllProjections();

    for (const projection of allProjections) {
      // Check highlights
      const highlight = projection.highlights.find((h: any) => h.id === selectionId);
      if (highlight) {
        return {
          id: highlight.id,
          documentId: projection.id,
          text: highlight.text,
          position: highlight.position,
          type: 'highlight',
        };
      }

      // Check references
      const reference = projection.references.find((r: any) => r.id === selectionId);
      if (reference) {
        return {
          id: reference.id,
          documentId: projection.id,
          text: reference.text,
          position: reference.position,
          type: 'reference',
          targetDocumentId: reference.targetDocumentId,
          entityTypes: reference.entityTypes,
        };
      }
    }

    return null;
  }

  /**
   * List selections with optional filtering
   * @param filters - Optional filters like documentId
   */
  static async listSelections(filters?: { documentId?: string }): Promise<any> {
    if (filters?.documentId) {
      // If filtering by document ID, use Layer 3 directly
      const highlights = await this.getHighlights(filters.documentId);
      const references = await this.getReferences(filters.documentId);
      return [...highlights, ...references];
    }

    // For now, fall back to graph for cross-document listing
    // TODO: Implement by scanning all projections
    const graphDb = await getGraphDatabase();
    const result = await graphDb.listAnnotations(filters || {});
    return result.annotations || [];
  }

  // ========================================
  // Graph Queries (Layer 4 only)
  // ========================================

  /**
   * Get all documents referencing this document (backlinks)
   * Requires graph traversal - must use Layer 4
   */
  static async getBacklinks(documentId: string): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.getDocumentReferencedBy(documentId);
  }

  /**
   * Find shortest path between two documents
   * Requires graph traversal - must use Layer 4
   */
  static async findPath(
    fromDocumentId: string,
    toDocumentId: string,
    maxDepth?: number
  ): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.findPath(fromDocumentId, toDocumentId, maxDepth);
  }

  /**
   * Get document connections (graph edges)
   * Requires graph traversal - must use Layer 4
   */
  static async getDocumentConnections(documentId: string): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.getDocumentConnections(documentId);
  }

  /**
   * Search documents by name (cross-document query)
   * Requires full-text search - must use Layer 4
   */
  static async searchDocuments(query: string, limit?: number): Promise<any[]> {
    const graphDb = await getGraphDatabase();
    return await graphDb.searchDocuments(query, limit);
  }
}