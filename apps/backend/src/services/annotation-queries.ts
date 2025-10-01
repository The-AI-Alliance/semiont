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
   * NOTE: This requires scanning projections since selections are stored within document projections
   * TODO: Add selection ID → document ID index for O(1) lookup
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
    // For now, fall back to graph for selection lookups
    // This is a known limitation - we'd need to scan all projections or maintain an index
    const graphDb = await getGraphDatabase();
    const selection = await graphDb.getSelection(selectionId);
    if (!selection) return null;

    return {
      id: selection.id,
      documentId: selection.documentId,
      text: selection.selectionData.text,
      position: {
        offset: selection.selectionData.offset,
        length: selection.selectionData.length,
      },
      type: selection.resolvedDocumentId ? 'reference' : 'highlight',
      targetDocumentId: selection.resolvedDocumentId || undefined,
      entityTypes: selection.entityTypes,
      referenceType: selection.referenceTags?.[0],
    };
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
    const result = await graphDb.listSelections(filters || {});
    return result.selections || [];
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