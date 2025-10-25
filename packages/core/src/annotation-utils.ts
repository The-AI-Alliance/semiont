/**
 * Backend-specific annotation utility functions
 */

import type { components } from '@semiont/api-client';
import type { BodyItem } from './events';

type Annotation = components['schemas']['Annotation'];

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
