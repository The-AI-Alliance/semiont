/**
 * Shared utility functions for working with W3C-compliant annotation bodies
 *
 * Note: extractEntityTypes and extractBodySource have been moved to @semiont/core
 * This file re-exports them for backward compatibility.
 */

import type { components } from '@semiont/api-client';
import { extractEntityTypes as coreExtractEntityTypes, extractBodySource as coreExtractBodySource } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

/**
 * Extract entity types from annotation body array
 * Entity types are stored as TextualBody with purpose: "tagging"
 *
 * @deprecated Use extractEntityTypes from @semiont/core instead
 */
export const extractEntityTypes = coreExtractEntityTypes;

/**
 * Extract source IRI from annotation body
 * Returns source of first SpecificResource found in body array, or null if stub
 *
 * @deprecated Use extractBodySource from @semiont/core instead
 */
export const extractBodySource = coreExtractBodySource;

/**
 * Check if annotation body is resolved (has SpecificResource with source)
 */
export function isBodyResolved(body: Annotation['body']): boolean {
  return extractBodySource(body) !== null;
}
