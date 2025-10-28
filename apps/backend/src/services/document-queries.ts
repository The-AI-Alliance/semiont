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

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface ListDocumentsFilters {
  search?: string;
  archived?: boolean;
}

export class DocumentQueryService {
  /**
   * Get document metadata from Layer 3 projection
   */
  static async getDocumentMetadata(documentId: string): Promise<ResourceDescriptor | null> {
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

    return state.document;
  }

  /**
   * List all documents by scanning Layer 3 projection files
   */
  static async listDocuments(filters?: ListDocumentsFilters): Promise<ResourceDescriptor[]> {
    const config = getFilesystemConfig();
    const basePath = config.path;

    // Use ProjectionManager to get all documents (respects configured subNamespace)
    const projectionManager = createProjectionManager(basePath, {
      subNamespace: 'documents',
    });

    const allStates = await projectionManager.getAll();
    const documents: ResourceDescriptor[] = [];

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

      documents.push(doc);
    }

    // Sort by creation date (newest first)
    documents.sort((a, b) => {
      const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
      const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
      return bTime - aTime;
    });

    return documents;
  }
}
