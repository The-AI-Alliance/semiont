/**
 * Entity Type Extraction Utilities
 *
 * Extract entity types from annotation bodies.
 * Entity types are stored as TextualBody with purpose: "tagging"
 */

import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

/**
 * Extract entity types from annotation bodies
 * Entity types are stored as TextualBody with purpose: "tagging"
 * Accepts any object with a body property matching Annotation['body']
 */
export function getEntityTypes(annotation: { body: Annotation['body'] }): string[] {
  // Extract from TextualBody bodies with purpose: "tagging"
  if (Array.isArray(annotation.body)) {
    const entityTags: string[] = [];

    for (const item of annotation.body) {
      // Runtime check for TextualBody with tagging purpose
      // TypeScript incorrectly narrows the union type here, so we use runtime checks only
      if (
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        'value' in item &&
        'purpose' in item
      ) {
        // Access properties as unknown first to avoid TypeScript narrowing issues
        const itemType = (item as { type: unknown }).type;
        const itemValue = (item as { value: unknown }).value;
        const itemPurpose = (item as { purpose: unknown }).purpose;

        if (itemType === 'TextualBody' && itemPurpose === 'tagging' && typeof itemValue === 'string' && itemValue.length > 0) {
          entityTags.push(itemValue);
        }
      }
    }

    return entityTags;
  }

  return [];
}
