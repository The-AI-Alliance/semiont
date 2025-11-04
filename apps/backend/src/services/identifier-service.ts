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
  resourceId,
  annotationId,
} from '@semiont/core';
import {
  type ResourceUri,
  type AnnotationUri,
  resourceUri,
  annotationUri,
  extractResourceId,
  extractAnnotationId,
} from '@semiont/api-client';

export interface IdentifierConfig {
  baseUrl: string;
}

// Convert IDs to URIs
export function toResourceUri(
  config: IdentifierConfig,
  id: ResourceId | string
): ResourceUri {
  if (!config.baseUrl) {
    throw new Error('baseUrl is required');
  }
  const idString = id as string;
  if (idString.includes('/')) {
    return resourceUri(idString);
  }
  return resourceUri(`${config.baseUrl}/resources/${idString}`);
}

export function toAnnotationUri(
  config: IdentifierConfig,
  id: AnnotationId | string
): AnnotationUri {
  if (!config.baseUrl) {
    throw new Error('baseUrl is required');
  }
  const idString = id as string;
  if (idString.includes('/')) {
    return annotationUri(idString);
  }
  return annotationUri(`${config.baseUrl}/annotations/${idString}`);
}

// Re-export extraction functions from core for convenience
export { extractResourceId, extractAnnotationId };

// Defensive helpers - handle both IDs and URIs
// IMPORTANT: Only accepts URIs that match the configured backend URL
export function normalizeResourceId(
  config: IdentifierConfig,
  idOrUri: string
): ResourceId {
  if (!idOrUri.includes('/')) {
    return resourceId(idOrUri);
  }

  // Validate that the URI matches our backend URL
  const expectedPrefix = `${config.baseUrl}/resources/`;
  if (!idOrUri.startsWith(expectedPrefix)) {
    throw new Error(
      `Invalid resource URI: expected ${expectedPrefix}*, got ${idOrUri}`
    );
  }

  return resourceId(extractResourceId(resourceUri(idOrUri)));
}

export function normalizeAnnotationId(
  config: IdentifierConfig,
  idOrUri: string
): AnnotationId {
  if (!idOrUri.includes('/')) {
    return annotationId(idOrUri);
  }

  // Validate that the URI matches our backend URL
  const expectedPrefix = `${config.baseUrl}/annotations/`;
  if (!idOrUri.startsWith(expectedPrefix)) {
    throw new Error(
      `Invalid annotation URI: expected ${expectedPrefix}*, got ${idOrUri}`
    );
  }

  return annotationId(extractAnnotationId(annotationUri(idOrUri)));
}
