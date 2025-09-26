// Helper functions for selection routes
import type { Document, Selection } from '@semiont/core-types';

export function formatDocument(doc: Document): any {
  return {
    id: doc.id,
    name: doc.name,
    contentType: doc.contentType,
    metadata: doc.metadata,
    archived: doc.archived || false,
    entityTypes: doc.entityTypes || [],
    createdBy: doc.createdBy,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
  };
}

export function formatDocumentWithContent(doc: Document, content: string): any {
  return {
    ...formatDocument(doc),
    content,
  };
}

export function formatSelection(sel: Selection): any {
  return {
    id: sel.id,
    documentId: sel.documentId,
    selectionData: sel.selectionData,
    resolvedDocumentId: sel.resolvedDocumentId,
    resolvedAt: sel.resolvedAt instanceof Date ? sel.resolvedAt.toISOString() : sel.resolvedAt,
    resolvedBy: sel.resolvedBy,
    referenceTags: sel.referenceTags,
    entityTypes: sel.entityTypes,
    provisional: sel.provisional,
    metadata: sel.metadata,
    createdBy: sel.createdBy,
    createdAt: sel.createdAt instanceof Date ? sel.createdAt.toISOString() : sel.createdAt,
    updatedAt: sel.updatedAt instanceof Date ? sel.updatedAt.toISOString() : sel.updatedAt,
  };
}