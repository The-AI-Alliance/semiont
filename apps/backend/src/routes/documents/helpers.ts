// Helper functions for document routes
import type { Document, Annotation } from '@semiont/core-types';
import { extractEntities } from '../../inference/entity-extractor';

export function formatDocument(doc: (Document | {
  id: string;
  name: string;
  contentType: string;
  metadata: Record<string, any>;
  archived: boolean;
  entityTypes: string[];
  creationMethod: string;
  sourceAnnotationId?: string;
  sourceDocumentId?: string;
  createdBy: string;
  createdAt: Date | string;
}) & { content?: string }): any {
  const formatted: any = {
    id: doc.id,
    name: doc.name,
    contentType: doc.contentType,
    metadata: doc.metadata,
    archived: doc.archived || false,
    entityTypes: doc.entityTypes || [],

    creationMethod: doc.creationMethod,
    sourceAnnotationId: doc.sourceAnnotationId,
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

export function formatAnnotation(annotation: Annotation): any {
  return {
    id: annotation.id,
    documentId: annotation.documentId,
    text: annotation.text,
    selectionData: annotation.selectionData,
    type: annotation.type,
    referencedDocumentId: annotation.referencedDocumentId,
    resolvedDocumentName: annotation.resolvedDocumentName,
    entityTypes: annotation.entityTypes,
    referenceType: annotation.referenceType,
  };
}

// Types for the detection result
export interface DetectedSelection {
  selection: {
    selectionData: {
      offset: number;
      length: number;
      text: string;
    };
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
          selectionData: {
            offset: entity.startOffset,
            length: entity.endOffset - entity.startOffset,
            text: entity.text,
          },
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