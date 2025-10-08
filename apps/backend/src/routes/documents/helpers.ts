// Helper functions for document routes
import type { Document, Annotation, DocumentProjection } from '@semiont/core-types';
import { extractEntities } from '../../inference/entity-extractor';
import { getStorageService } from '../../storage/filesystem';

export function formatDocument(source: Document | DocumentProjection): Document {
  const doc: Document = {
    id: source.id,
    name: source.name,
    contentType: source.contentType,
    metadata: source.metadata,
    archived: source.archived,
    entityTypes: source.entityTypes,
    creationMethod: source.creationMethod,
    sourceAnnotationId: source.sourceAnnotationId,
    sourceDocumentId: source.sourceDocumentId,
    contentChecksum: source.contentChecksum,
    createdBy: source.createdBy,
    createdAt: source.createdAt,
  };
  return doc;
}

// For search results ONLY - includes content preview
export function formatSearchResult(doc: Document, contentPreview: string): Document & { content: string } {
  const base = formatDocument(doc);
  return {
    ...base,
    content: contentPreview,
  };
}

export function formatAnnotation(annotation: Annotation): any {
  return {
    id: annotation.id,
    documentId: annotation.documentId,
    exact: annotation.exact,
    selector: annotation.selector,
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
    selector: {
      offset: number;
      length: number;
      exact: string;
    };
    entityTypes: string[];
    metadata: Record<string, any>;
  };
}

// Implementation for detecting entity references in document using AI
export async function detectSelectionsInDocument(
  documentId: string,
  contentType: string,
  entityTypes: string[]
): Promise<DetectedSelection[]> {
  console.log(`Detecting entities of types: ${entityTypes.join(', ')}`);

  const detectedSelections: DetectedSelection[] = [];

  // Only process text content
  if (contentType === 'text/plain' || contentType === 'text/markdown') {
    // Load content from filesystem
    const storage = getStorageService();
    const contentBuffer = await storage.getDocument(documentId);
    const content = contentBuffer.toString('utf-8');

    // Use AI to extract entities
    const extractedEntities = await extractEntities(content, entityTypes);

    // Convert extracted entities to selection format
    for (const entity of extractedEntities) {
      const selection: DetectedSelection = {
        selection: {
          selector: {
            offset: entity.startOffset,
            length: entity.endOffset - entity.startOffset,
            exact: entity.exact,
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