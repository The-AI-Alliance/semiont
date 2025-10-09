// Helper functions for document routes
import type { Document, Annotation } from '@semiont/core-types';
import { extractEntities } from '../../inference/entity-extractor';
import { getStorageService } from '../../storage/filesystem';

export function formatDocument(source: Document): Document {
  return source;
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
export interface DetectedAnnotation {
  annotation: {
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
export async function detectAnnotationsInDocument(
  documentId: string,
  contentType: string,
  entityTypes: string[]
): Promise<DetectedAnnotation[]> {
  console.log(`Detecting entities of types: ${entityTypes.join(', ')}`);

  const detectedAnnotations: DetectedAnnotation[] = [];

  // Only process text content
  if (contentType === 'text/plain' || contentType === 'text/markdown') {
    // Load content from filesystem
    const storage = getStorageService();
    const contentBuffer = await storage.getDocument(documentId);
    const content = contentBuffer.toString('utf-8');

    // Use AI to extract entities
    const extractedEntities = await extractEntities(content, entityTypes);

    // Convert extracted entities to annotation format
    for (const entity of extractedEntities) {
      const annotation: DetectedAnnotation = {
        annotation: {
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
      detectedAnnotations.push(annotation);
    }
  }

  return detectedAnnotations;
}