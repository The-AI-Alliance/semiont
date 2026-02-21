/**
 * Tag Schema Extraction Utilities
 *
 * Extract tag categories and schema IDs from tag annotations.
 * Tags use dual-body structure:
 * - First body has purpose: "tagging" with category value
 * - Second body has purpose: "classifying" with schema ID
 */

import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

/**
 * Type guard to check if an annotation is a tag
 */
function isTag(annotation: Annotation): boolean {
  return annotation.motivation === 'tagging';
}

/**
 * Extract tag category from a tag annotation's body
 * Tags use dual-body structure: first body has purpose: "tagging" with category value
 * @param annotation - The annotation to extract category from
 * @returns The tag category (e.g., "Issue", "Rule"), or undefined if not a tag or no category found
 */
export function getTagCategory(annotation: Annotation): string | undefined {
  if (!isTag(annotation)) return undefined;
  const bodies = Array.isArray(annotation.body) ? annotation.body : [annotation.body];
  const taggingBody = bodies.find((b): b is Extract<typeof b, { purpose?: string }> =>
    b !== null && typeof b === 'object' && 'purpose' in b && b.purpose === 'tagging'
  );
  if (taggingBody && 'value' in taggingBody) {
    return taggingBody.value as string;
  }
  return undefined;
}

/**
 * Extract tag schema ID from a tag annotation's body
 * Tags use dual-body structure: second body has purpose: "classifying" with schema ID
 * @param annotation - The annotation to extract schema ID from
 * @returns The schema ID (e.g., "legal-irac"), or undefined if not a tag or no schema found
 */
export function getTagSchemaId(annotation: Annotation): string | undefined {
  if (!isTag(annotation)) return undefined;
  const bodies = Array.isArray(annotation.body) ? annotation.body : [annotation.body];
  const classifyingBody = bodies.find((b): b is Extract<typeof b, { purpose?: string }> =>
    b !== null && typeof b === 'object' && 'purpose' in b && b.purpose === 'classifying'
  );
  if (classifyingBody && 'value' in classifyingBody) {
    return classifyingBody.value as string;
  }
  return undefined;
}
