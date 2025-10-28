// Helper functions for document routes
import type { components } from '@semiont/api-client';
import { extractEntities } from '../../inference/entity-extractor';
import { getFilesystemConfig } from '../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation } from '../../utils/resource-helpers';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// For search results ONLY - includes content preview
export function formatSearchResult(doc: ResourceDescriptor, contentPreview: string): ResourceDescriptor & { content: string } {
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
  resource: ResourceDescriptor,
  entityTypes: string[]
): Promise<DetectedAnnotation[]> {
  console.log(`Detecting entities of types: ${entityTypes.join(', ')}`);

  const detectedAnnotations: DetectedAnnotation[] = [];

  // Get primary representation
  const primaryRep = getPrimaryRepresentation(resource);
  if (!primaryRep) return detectedAnnotations;

  // Only process text content
  const mediaType = primaryRep.mediaType;
  if (mediaType === 'text/plain' || mediaType === 'text/markdown') {
    // Load content from representation store
    if (!primaryRep.storageUri) return detectedAnnotations;

    const basePath = getFilesystemConfig().path;
    const repStore = new FilesystemRepresentationStore({ basePath });
    const contentBuffer = await repStore.retrieve(primaryRep.storageUri);
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