/**
 * Layer 3: Document Query Service
 *
 * Reads document metadata from projection storage (Layer 3)
 * Does NOT touch the graph - graph is only for traversals
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getFilesystemConfig } from '../config/environment-loader';
import type { CreationMethod } from '@semiont/core-types';
import type { StoredProjection } from '../storage/projection-storage';

export interface DocumentMetadata {
  id: string;
  name: string;
  contentType: string;
  contentChecksum: string;
  metadata: Record<string, any>;
  entityTypes: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  creationMethod: CreationMethod;
  sourceAnnotationId?: string;
  sourceDocumentId?: string;
  createdBy: string;
}

export interface ListDocumentsFilters {
  search?: string;
  archived?: boolean;
}

export class DocumentQueryService {
  /**
   * Get document metadata from Layer 3 projection
   */
  static async getDocumentMetadata(documentId: string): Promise<DocumentMetadata | null> {
    const config = getFilesystemConfig();
    const basePath = config.path;

    // Projection is sharded at data/annotations/{ab}/{cd}/{documentId}.json
    const [ab, cd] = getShardPath(documentId);
    const projPath = path.join(basePath, 'annotations', ab, cd, `${documentId}.json`);

    try {
      const content = await fs.readFile(projPath, 'utf-8');
      const stored: StoredProjection = JSON.parse(content);
      const doc = stored.document;

      return {
        id: doc.id,
        name: doc.name,
        contentType: doc.contentType,
        contentChecksum: doc.contentChecksum,
        metadata: doc.metadata,
        entityTypes: doc.entityTypes,
        archived: doc.archived,
        createdAt: doc.createdAt,
        updatedAt: stored.annotations.updatedAt,
        creationMethod: doc.creationMethod,
        sourceAnnotationId: doc.sourceAnnotationId,
        sourceDocumentId: doc.sourceDocumentId,
        createdBy: doc.createdBy,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all documents by scanning Layer 3 projection files
   */
  static async listDocuments(filters?: ListDocumentsFilters): Promise<DocumentMetadata[]> {
    const config = getFilesystemConfig();
    const basePath = config.path;
    const annotationsPath = path.join(basePath, 'annotations');

    const documents: DocumentMetadata[] = [];

    try {
      // Scan all shards (00-ff / 00-ff)
      const shardDirs = await fs.readdir(annotationsPath);

      for (const ab of shardDirs) {
        const abPath = path.join(annotationsPath, ab);
        const abStat = await fs.stat(abPath);
        if (!abStat.isDirectory()) continue;

        const cdDirs = await fs.readdir(abPath);

        for (const cd of cdDirs) {
          const cdPath = path.join(abPath, cd);
          const cdStat = await fs.stat(cdPath);
          if (!cdStat.isDirectory()) continue;

          const files = await fs.readdir(cdPath);

          for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const filePath = path.join(cdPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const stored: StoredProjection = JSON.parse(content);
            const doc = stored.document;

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
              contentType: doc.contentType,
              contentChecksum: doc.contentChecksum,
              metadata: doc.metadata,
              entityTypes: doc.entityTypes,
              archived: doc.archived,
              createdAt: doc.createdAt,
              updatedAt: stored.annotations.updatedAt,
              creationMethod: doc.creationMethod,
              sourceAnnotationId: doc.sourceAnnotationId,
              sourceDocumentId: doc.sourceDocumentId,
              createdBy: doc.createdBy,
            });
          }
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // No annotations directory yet
        return [];
      }
      throw error;
    }

    // Sort by creation date (newest first)
    documents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return documents;
  }
}

// Helper function from shard-utils (simplified for document queries)
function getShardPath(id: string): [string, string] {
  // Simple hash-based sharding to match existing structure
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }

  // Get positive value and mod to 65536
  const bucketIndex = Math.abs(hash) % 65536;
  const hex = bucketIndex.toString(16).padStart(4, '0');
  const ab = hex.substring(0, 2);
  const cd = hex.substring(2, 4);

  return [ab, cd];
}
