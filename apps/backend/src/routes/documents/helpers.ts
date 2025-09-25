// Helper functions for document routes
import type { Document, Selection } from '@semiont/core-types';
import { extractEntities } from '../../inference/entity-extractor';

export function formatDocument(doc: Document & { content?: string }): any {
  const formatted: any = {
    id: doc.id,
    name: doc.name,
    contentType: doc.contentType,
    metadata: doc.metadata,
    archived: doc.archived || false,
    entityTypes: doc.entityTypes || [],

    creationMethod: doc.creationMethod,
    sourceSelectionId: doc.sourceSelectionId,
    sourceDocumentId: doc.sourceDocumentId,

    createdBy: doc.createdBy,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
  };

  // Include content if it exists (for search results)
  if ('content' in doc) {
    formatted.content = doc.content;
  }

  return formatted;
}

export function formatSelection(sel: Selection): any {
  return {
    id: sel.id,
    documentId: sel.documentId,
    selectionType: sel.selectionType,
    selectionData: sel.selectionData,
    resolvedDocumentId: sel.resolvedDocumentId,
    resolvedAt: sel.resolvedAt instanceof Date ? sel.resolvedAt.toISOString() : sel.resolvedAt,
    resolvedBy: sel.resolvedBy,
    referenceTags: sel.referenceTags,
    entityTypes: sel.entityTypes,
    provisional: sel.provisional,
    confidence: sel.confidence,
    metadata: sel.metadata,
    createdBy: sel.createdBy,
    createdAt: sel.createdAt instanceof Date ? sel.createdAt.toISOString() : sel.createdAt,
    updatedAt: sel.updatedAt instanceof Date ? sel.updatedAt.toISOString() : sel.updatedAt,
  };
}

// Types for the detection result
export interface DetectedSelection {
  selection: {
    selectionType: string;
    selectionData: {
      type: string;
      offset: number;
      length: number;
      text: string;
    };
    provisional: boolean;
    entityTypes: string[];
    metadata: Record<string, any>;
  };
}

// Implementation for detecting entity references in document using AI
export async function detectSelectionsInDocument(
  document: any,
  entityTypes: string[]
): Promise<DetectedSelection[]> {
  console.log(`Detecting entities of types: ${entityTypes.join(', ')}`);

  const detectedSelections: DetectedSelection[] = [];

  // Only process text content
  if (document.contentType === 'text/plain' || document.contentType === 'text/markdown') {
    const content = document.content;

    // Use AI to extract entities
    const extractedEntities = await extractEntities(content, entityTypes);

    // Convert extracted entities to selection format
    for (const entity of extractedEntities) {
      const selection: DetectedSelection = {
        selection: {
          selectionType: 'text_span',
          selectionData: {
            type: 'text_span',
            offset: entity.startOffset,
            length: entity.endOffset - entity.startOffset,
            text: entity.text,
          },
          provisional: true,
          entityTypes: [entity.entityType],
          metadata: {
            detectionType: 'ai_extraction',
            extractedBy: 'inference/entity-extractor',
          },
        },
      };
      detectedSelections.push(selection);
    }
  }

  return detectedSelections;
}