// Helper functions for document routes
import type { components } from '@semiont/api-client';
import { extractEntities } from '../../inference/entity-extractor';
import { createContentManager } from '../../services/storage-service';
import { getFilesystemConfig } from '../../config/environment-loader';

type Document = components['schemas']['Document'];

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
      start: number;
      end: number;
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
    const basePath = getFilesystemConfig().path;
    const contentManager = createContentManager(basePath);
    const contentBuffer = await contentManager.get(documentId);
    const content = contentBuffer.toString('utf-8');

    // Use AI to extract entities
    const extractedEntities = await extractEntities(content, entityTypes);

    // Convert extracted entities to annotation format
    for (const entity of extractedEntities) {
      const annotation: DetectedAnnotation = {
        annotation: {
          selector: {
            start: entity.startOffset,
            end: entity.endOffset,
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