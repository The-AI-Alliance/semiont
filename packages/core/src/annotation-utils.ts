/**
 * Annotation utility functions
 */

import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

/**
 * Compare two annotation IDs (handles URI vs internal ID formats)
 */
export function compareAnnotationIds(id1: string, id2: string): boolean {
  const extractId = (id: string) => id.includes('/') ? id.split('/').pop()! : id;
  return extractId(id1) === extractId(id2);
}

/**
 * Extract entity types from W3C annotation body array
 * Entity types are stored as TextualBody with purpose: "tagging"
 */
export function extractEntityTypes(body: Annotation['body']): string[] {
  if (!Array.isArray(body)) {
    return [];
  }

  const entityTypes: string[] = [];

  for (const item of body) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      'value' in item &&
      'purpose' in item
    ) {
      const itemType = (item as { type: unknown }).type;
      const itemValue = (item as { value: unknown }).value;
      const itemPurpose = (item as { purpose: unknown }).purpose;

      if (itemType === 'TextualBody' && itemPurpose === 'tagging' && typeof itemValue === 'string' && itemValue.length > 0) {
        entityTypes.push(itemValue);
      }
    }
  }

  return entityTypes;
}

/**
 * Extract source IRI from annotation body
 * Returns source of first SpecificResource found in body array, or null if stub
 */
export function extractBodySource(body: Annotation['body']): string | null {
  if (Array.isArray(body)) {
    for (const item of body) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        'source' in item
      ) {
        const itemType = (item as { type: unknown }).type;
        const itemSource = (item as { source: unknown }).source;

        if (itemType === 'SpecificResource' && typeof itemSource === 'string') {
          return itemSource;
        }
      }
    }
    return null;
  }

  // Single body object (SpecificResource)
  if (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    'source' in body
  ) {
    const bodyType = (body as { type: unknown }).type;
    const bodySource = (body as { source: unknown }).source;

    if (bodyType === 'SpecificResource' && typeof bodySource === 'string') {
      return bodySource;
    }
  }

  return null;
}
