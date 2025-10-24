/**
 * Annotation utility functions
 */

import type { components } from '@semiont/api-client';
import type { BodyItem } from './events';

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

/**
 * Check if two body items match (for remove/replace operations)
 * Matches by type, value/source, and purpose fields
 */
export function bodyItemsMatch(item1: BodyItem, item2: BodyItem): boolean {
  // Type must match
  if (item1.type !== item2.type) {
    return false;
  }

  // Purpose must match
  if (item1.purpose !== item2.purpose) {
    return false;
  }

  // For TextualBody, match by value
  if (item1.type === 'TextualBody' && item2.type === 'TextualBody') {
    return item1.value === item2.value;
  }

  // For SpecificResource, match by source
  if (item1.type === 'SpecificResource' && item2.type === 'SpecificResource') {
    return item1.source === item2.source;
  }

  return false;
}

/**
 * Find a body item in an array
 * Returns the index of the first matching item, or -1 if not found
 */
export function findBodyItem(body: Annotation['body'], targetItem: BodyItem): number {
  if (!Array.isArray(body)) {
    return -1;
  }

  for (let i = 0; i < body.length; i++) {
    const item = body[i];

    // Check if this is a valid body item that can be matched
    if (
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      'purpose' in item
    ) {
      const itemType = (item as { type: unknown }).type;
      const itemPurpose = (item as { purpose: unknown }).purpose;

      // Type and purpose must match
      if (itemType !== targetItem.type || itemPurpose !== targetItem.purpose) {
        continue;
      }

      // For TextualBody, match by value
      if (targetItem.type === 'TextualBody' && 'value' in item) {
        const itemValue = (item as { value: unknown }).value;
        if (itemValue === targetItem.value) {
          return i;
        }
      }

      // For SpecificResource, match by source
      if (targetItem.type === 'SpecificResource' && 'source' in item) {
        const itemSource = (item as { source: unknown }).source;
        if (itemSource === targetItem.source) {
          return i;
        }
      }
    }
  }

  return -1;
}
