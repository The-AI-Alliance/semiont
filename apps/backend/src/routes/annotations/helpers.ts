// Helper functions for annotation routes
import type { Document } from '@semiont/core-types';

export function formatDocument(doc: Document): any {
  return {
    id: doc.id,
    name: doc.name,
    format: doc.format,
    archived: doc.archived || false,
    entityTypes: doc.entityTypes || [],
    creator: doc.creator,
    created: doc.created, // Already ISO string
  };
}

export function formatDocumentWithContent(doc: Document, content: string): any {
  return {
    ...formatDocument(doc),
    content,
  };
}

