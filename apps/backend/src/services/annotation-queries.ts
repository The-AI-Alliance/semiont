/**
 * Annotation Query Service
 *
 * Optimized read path for document annotations
 * - Single-document queries use Layer 3 (filesystem projections)
 * - Graph queries use Layer 4 (graph database)
 */

import { getProjectionStorage } from '../storage/projection-storage';
import { getGraphDatabase } from '../graph/factory';
import type { Annotation, DocumentAnnotations } from '@semiont/core';

export class AnnotationQueryService {
  /**
   * Get document annotations from Layer 3 (fast path)
   * Falls back to GraphDB if projection missing
   */
  static async getDocumentAnnotations(documentId: string): Promise<DocumentAnnotations> {
    const projectionStorage = getProjectionStorage();
    const stored = await projectionStorage.getProjection(documentId);

    if (!stored) {
      throw new Error(`Document ${documentId} not found in Layer 3 projections`);
    }

    return stored.annotations;
  }

  /**
   * Get highlights only (filtered by motivation)
   * @returns Array of highlighting annotations
   */
  static async getHighlights(documentId: string): Promise<Annotation[]> {
    const annotations = await this.getDocumentAnnotations(documentId);
    return annotations.annotations.filter(a => a.motivation === 'highlighting');
  }

  /**
   * Get references only (filtered by motivation)
   * @returns Array of linking annotations
   */
  static async getReferences(documentId: string): Promise<Annotation[]> {
    const annotations = await this.getDocumentAnnotations(documentId);
    return annotations.annotations.filter(a => a.motivation === 'linking');
  }

  /**
   * Get all annotations
   * @returns Array of all annotation objects
   */
  static async getAllAnnotations(documentId: string): Promise<Annotation[]> {
    const annotations = await this.getDocumentAnnotations(documentId);
    return annotations.annotations;
  }

  /**
   * Get document stats (version info)
   * @returns Version and timestamp info for the annotations
   */
  static async getDocumentStats(documentId: string): Promise<{
    documentId: string;
    version: number;
    updatedAt: string;
  }> {
    const annotations = await this.getDocumentAnnotations(documentId);
    return {
      documentId: annotations.documentId,
      version: annotations.version,
      updatedAt: annotations.updatedAt,
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
   * Get a single annotation by ID
   * Scans Layer 3 projections to find the annotation
   * O(n) complexity - needs annotation ID → document ID index for O(1)
   */
  static async getAnnotation(annotationId: string): Promise<Annotation | null> {
    const projectionStorage = getProjectionStorage();
    const allProjections = await projectionStorage.getAllProjections();

    for (const stored of allProjections) {
      // Check all annotations
      const annotation = stored.annotations.annotations.find((a: Annotation) => a.id === annotationId);
      if (annotation) {
        return annotation;
      }
    }

    return null;
  }

  /**
   * List annotations with optional filtering
   * @param filters - Optional filters like documentId
   */
  static async listAnnotations(filters?: { documentId?: string }): Promise<any> {
    if (filters?.documentId) {
      // If filtering by document ID, use Layer 3 directly
      return await this.getAllAnnotations(filters.documentId);
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