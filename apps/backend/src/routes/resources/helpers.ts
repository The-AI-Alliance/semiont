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
      prefix?: string;
      suffix?: string;
    };
    entityTypes: string[];
  };
}

/**
 * Extract prefix and suffix context for TextQuoteSelector
 * Extracts up to 64 characters before and after the selected text,
 * extending to word boundaries to avoid cutting words in half.
 * This ensures prefix/suffix are meaningful context for fuzzy anchoring.
 *
 * @param content - Full text content
 * @param start - Start offset of selection
 * @param end - End offset of selection
 * @returns Object with prefix and suffix (undefined if at boundaries)
 */
function extractContext(content: string, start: number, end: number): { prefix?: string; suffix?: string } {
  const CONTEXT_LENGTH = 64;
  const MAX_EXTENSION = 32; // Maximum additional chars to extend for word boundary

  // Extract prefix (up to CONTEXT_LENGTH chars before start, extended to word boundary)
  let prefix: string | undefined;
  if (start > 0) {
    let prefixStart = Math.max(0, start - CONTEXT_LENGTH);

    // Extend backward to word boundary (whitespace or punctuation)
    // Stop if we hit start of content or exceed MAX_EXTENSION
    let extensionCount = 0;
    while (prefixStart > 0 && extensionCount < MAX_EXTENSION) {
      const char = content[prefixStart - 1];
      // Break on whitespace, punctuation, or common delimiters
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) {
        break;
      }
      prefixStart--;
      extensionCount++;
    }

    prefix = content.substring(prefixStart, start);
  }

  // Extract suffix (up to CONTEXT_LENGTH chars after end, extended to word boundary)
  let suffix: string | undefined;
  if (end < content.length) {
    let suffixEnd = Math.min(content.length, end + CONTEXT_LENGTH);

    // Extend forward to word boundary (whitespace or punctuation)
    // Stop if we hit end of content or exceed MAX_EXTENSION
    let extensionCount = 0;
    while (suffixEnd < content.length && extensionCount < MAX_EXTENSION) {
      const char = content[suffixEnd];
      // Break on whitespace, punctuation, or common delimiters
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) {
        break;
      }
      suffixEnd++;
      extensionCount++;
    }

    suffix = content.substring(end, suffixEnd);
  }

  return { prefix, suffix };
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

    // Convert extracted entities to annotation format with prefix/suffix context
    for (const entity of extractedEntities) {
      const context = extractContext(content, entity.startOffset, entity.endOffset);

      const annotation: DetectedAnnotation = {
        annotation: {
          selector: {
            start: entity.startOffset,
            end: entity.endOffset,
            exact: entity.exact,
            ...context, // Add prefix/suffix if available
          },
          entityTypes: [entity.entityType],
        },
      };
      detectedAnnotations.push(annotation);
    }
  }

  return detectedAnnotations;
}