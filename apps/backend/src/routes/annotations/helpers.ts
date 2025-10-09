// Helper functions for selection routes
import type { Document } from '@semiont/core-types';

export function formatDocument(doc: Document): any {
  return {
    id: doc.id,
    name: doc.name,
    contentType: doc.contentType,
    archived: doc.archived || false,
    entityTypes: doc.entityTypes || [],
    createdBy: doc.createdBy,
    createdAt: doc.createdAt, // Already ISO string
  };
}

export function formatDocumentWithContent(doc: Document, content: string): any {
  return {
    ...formatDocument(doc),
    content,
  };
}

