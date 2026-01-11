/**
 * Identifier conversion functions - Convert between short IDs and W3C-compliant HTTP URIs
 *
 * These functions handle the conversion between:
 * - Short IDs (e.g., "abc123") - used internally in events
 * - HTTP URIs (e.g., "http://localhost:4000/resources/abc123") - used in API responses
 *
 * The W3C Web Annotation Model requires HTTP(S) URIs for @id fields.
 *
 * All functions are pure - they take config explicitly as a parameter.
 */

import {
  type ResourceId,
  type AnnotationId,
} from '@semiont/core';
import {
  type ResourceUri,
  type AnnotationUri,
  resourceUri,
  annotationUri,
} from '@semiont/api-client';
import type { IdentifierConfig } from './types';

// Re-export IdentifierConfig for convenience
export type { IdentifierConfig };

// Convert IDs to URIs
export function toResourceUri(
  config: IdentifierConfig,
  id: ResourceId
): ResourceUri {
  if (!config.baseUrl) {
    throw new Error('baseUrl is required');
  }
  return resourceUri(`${config.baseUrl}/resources/${id}`);
}

export function toAnnotationUri(
  config: IdentifierConfig,
  id: AnnotationId
): AnnotationUri {
  if (!config.baseUrl) {
    throw new Error('baseUrl is required');
  }
  return annotationUri(`${config.baseUrl}/annotations/${id}`);
}
