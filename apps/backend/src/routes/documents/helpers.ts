// Helper functions for document routes
import type { Document } from '@semiont/core';
import { extractEntities } from '../../inference/entity-extractor';
import { createContentManager } from '../../services/storage-service';

// For search results ONLY - includes content preview
export function formatSearchResult(doc: Document, contentPreview: string): Document & { content: string } {
  return {
    ...doc,
    content: contentPreview,
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
  };
}

// Implementation for detecting entity references in document using AI
export async function detectAnnotationsInDocument(
  documentId: string,
  format: string,
  entityTypes: string[]
): Promise<DetectedAnnotation[]> {
  console.log(`Detecting entities of types: ${entityTypes.join(', ')}`);

  const detectedAnnotations: DetectedAnnotation[] = [];

  // Only process text content
  if (format === 'text/plain' || format === 'text/markdown') {
    // Load content from filesystem
    const contentManager = createContentManager();
    const contentBuffer = await contentManager.get(documentId);
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
        },
      };
      detectedAnnotations.push(annotation);
    }
  }

  return detectedAnnotations;
}