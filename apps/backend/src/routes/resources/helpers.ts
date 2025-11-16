// Helper functions for resource routes
import type { components } from '@semiont/api-client';
import { extractEntities } from '../../inference/entity-extractor';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation, decodeRepresentation } from '../../utils/resource-helpers';
import type { EnvironmentConfig } from '@semiont/core';

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

// Implementation for detecting entity references in resource using AI
export async function detectAnnotationsInResource(
  resource: ResourceDescriptor,
  entityTypes: string[],
  config: EnvironmentConfig
): Promise<DetectedAnnotation[]> {
  console.log(`Detecting entities of types: ${entityTypes.join(', ')}`);

  const detectedAnnotations: DetectedAnnotation[] = [];

  // Get primary representation
  const primaryRep = getPrimaryRepresentation(resource);
  if (!primaryRep) return detectedAnnotations;

  // Only process text content (check base media type, ignoring charset parameters)
  const mediaType = primaryRep.mediaType;
  const baseMediaType = mediaType?.split(';')[0]?.trim() || '';
  if (baseMediaType === 'text/plain' || baseMediaType === 'text/markdown') {
    // Load content from representation store using content-addressed lookup
    if (!primaryRep.checksum || !primaryRep.mediaType) return detectedAnnotations;

    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);
    const contentBuffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    const content = decodeRepresentation(contentBuffer, primaryRep.mediaType);

    // Use AI to extract entities
    const extractedEntities = await extractEntities(content, entityTypes, config);

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