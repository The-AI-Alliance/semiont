/**
 * Layer 3: Document Query Service
 *
 * Reads document metadata from projection storage (Layer 3)
 * Does NOT touch the graph - graph is only for traversals
 *
 * Uses ProjectionManager as single source of truth for paths
 */

import { getFilesystemConfig } from '../config/environment-loader';
import { createProjectionManager } from './storage-service';
import type { components } from '@semiont/api-client';
import type { CreationMethod } from '@semiont/core';

type Document = components['schemas']['Document'];

export interface ListDocumentsFilters {
  search?: string;
  archived?: boolean;
}

export class DocumentQueryService {
  /**
   * Get document metadata from Layer 3 projection
   */
  static async getDocumentMetadata(documentId: string): Promise<Document | null> {
    const config = getFilesystemConfig();
    const basePath = config.path;

    // Use ProjectionManager to get projection (respects configured subNamespace)
    const projectionManager = createProjectionManager(basePath, {
      subNamespace: 'documents',
    });

    const state = await projectionManager.get(documentId);
    if (!state) {
      return null;
    }

    const doc = state.document;
    return {
      id: doc.id,
      name: doc.name,
      format: doc.format,
      contentChecksum: doc.contentChecksum,
      entityTypes: doc.entityTypes,
      archived: doc.archived,
      created: doc.created,
      creationMethod: doc.creationMethod as CreationMethod,
      sourceAnnotationId: doc.sourceAnnotationId,
      sourceDocumentId: doc.sourceDocumentId,
      creator: doc.creator,
      language: doc.language,
    };
  }

  /**
   * List all documents by scanning Layer 3 projection files
   */
  static async listDocuments(filters?: ListDocumentsFilters): Promise<Document[]> {
    const config = getFilesystemConfig();
    const basePath = config.path;

    // Use ProjectionManager to get all documents (respects configured subNamespace)
    const projectionManager = createProjectionManager(basePath, {
      subNamespace: 'documents',
    });

    const allStates = await projectionManager.getAll();
    const documents: Document[] = [];

    for (const state of allStates) {
      const doc = state.document;

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

      documents.push({
        id: doc.id,
        name: doc.name,
        format: doc.format,
        contentChecksum: doc.contentChecksum,
        entityTypes: doc.entityTypes,
        archived: doc.archived,
        created: doc.created,
        creationMethod: doc.creationMethod as CreationMethod,
        sourceAnnotationId: doc.sourceAnnotationId,
        sourceDocumentId: doc.sourceDocumentId,
        creator: doc.creator,
        language: doc.language,
      });
    }

    // Sort by creation date (newest first)
    documents.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    return documents;
  }
}
