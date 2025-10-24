/**
 * Helper functions for creating W3C-compliant test annotations
 */

import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

/**
 * Extract entity types from annotation bodies
 */
export function getEntityTypes(annotation: Annotation): string[] {
  if (Array.isArray(annotation.body)) {
    const entityTags: string[] = [];

    for (const item of annotation.body) {
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
          entityTags.push(itemValue);
        }
      }
    }

    return entityTags;
  }

  return [];
}

/**
 * Get source from annotation body
 */
export function getBodySource(body: Annotation['body']): string | null {
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
 * Check if annotation is resolved (has SpecificResource in body)
 */
export function isResolved(annotation: Annotation): boolean {
  return getBodySource(annotation.body) !== null;
}
