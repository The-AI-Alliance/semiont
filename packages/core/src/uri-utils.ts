/**
 * URI utilities for W3C annotations
 *
 * Converts between short resource/annotation IDs and full URIs.
 * Full URIs are required by W3C Web Annotation Data Model.
 */

import { resourceId, annotationId, type ResourceId, type AnnotationId } from './identifiers';
import { resourceUri, annotationUri, type ResourceUri, type AnnotationUri, type ResourceAnnotationUri } from '@semiont/api-client';

/**
 * Convert resource ID to full URI
 *
 * @param id - Short resource ID (e.g., "doc-abc123")
 * @param publicURL - Backend base URL
 * @returns Full URI (e.g., "https://api.semiont.app/resources/doc-abc123")
 *
 * @example
 * resourceIdToURI("doc-abc123", "https://api.semiont.app")
 * // => "https://api.semiont.app/resources/doc-abc123"
 */
export function resourceIdToURI(id: ResourceId, publicURL: string): ResourceUri {
  // Remove trailing slash if present
  const normalizedBase = publicURL.endsWith('/') ? publicURL.slice(0, -1) : publicURL;
  return resourceUri(`${normalizedBase}/resources/${id}` );
}

/**
 * Extract resource ID from full URI
 *
 * @param uri - Full resource URI (e.g., "https://api.semiont.app/resources/doc-abc123")
 * @returns Short resource ID (e.g., "doc-abc123")
 * @throws Error if URI format is invalid
 *
 * @example
 * uriToResourceId("https://api.semiont.app/resources/doc-abc123")
 * // => "doc-abc123"
 */
export function uriToResourceId(uri: string): ResourceId {
  const url = new URL(uri);
  const match = url.pathname.match(/\/resources\/([^/]+)/);
  if (!match || !match[1]) {
    throw new Error(`Invalid resource URI: ${uri}`);
  }
  return resourceId(match[1]);
}

/**
 * Convert annotation ID to full URI
 *
 * @param id - Short annotation ID (e.g., "anno-xyz789")
 * @param publicURL - Backend base URL
 * @returns Full URI (e.g., "https://api.semiont.app/annotations/anno-xyz789")
 *
 * @example
 * annotationIdToURI("anno-xyz789", "https://api.semiont.app")
 * // => "https://api.semiont.app/annotations/anno-xyz789"
 */
export function annotationIdToURI(id: AnnotationId, publicURL: string): AnnotationUri {
  // Remove trailing slash if present
  const normalizedBase = publicURL.endsWith('/') ? publicURL.slice(0, -1) : publicURL;
  return annotationUri(`${normalizedBase}/annotations/${id}`);
}

/**
 * Extract annotation ID from full URI
 *
 * @param uri - Full annotation URI (e.g., "https://api.semiont.app/annotations/anno-xyz789")
 * @returns Short annotation ID (e.g., "anno-xyz789")
 * @throws Error if URI format is invalid
 *
 * @example
 * uriToAnnotationId("https://api.semiont.app/annotations/anno-xyz789")
 * // => "anno-xyz789"
 */
export function uriToAnnotationId(uri: string): AnnotationId {
  const url = new URL(uri);
  const match = url.pathname.match(/\/annotations\/([^/]+)/);
  if (!match || !match[1]) {
    throw new Error(`Invalid annotation URI: ${uri}`);
  }
  return annotationId(match[1]);
}

/**
 * Extract annotation ID from URI or pass through if already an ID
 *
 * Defensive version of uriToAnnotationId that handles both:
 * - Full URIs: "https://api.semiont.app/annotations/anno-xyz789" → "anno-xyz789"
 * - Already IDs: "anno-xyz789" → "anno-xyz789"
 *
 * @param uriOrId - Full annotation URI or short ID
 * @returns Short annotation ID
 *
 * @example
 * uriToAnnotationIdOrPassthrough("https://api.semiont.app/annotations/anno-xyz789")
 * // => "anno-xyz789"
 *
 * uriToAnnotationIdOrPassthrough("anno-xyz789")
 * // => "anno-xyz789"
 */
export function uriToAnnotationIdOrPassthrough(uriOrId: string): AnnotationId {
  // Try parsing as URI first
  try {
    return uriToAnnotationId(uriOrId);
  } catch {
    // If it fails, assume it's already an ID and return as-is
    return annotationId(uriOrId);
  }
}

/**
 * Extract resource URI from nested annotation URI
 *
 * @param annotationUri - Nested ResourceAnnotationUri (e.g., "https://api.semiont.app/resources/doc-123/annotations/anno-456")
 * @returns Resource URI (e.g., "https://api.semiont.app/resources/doc-123")
 * @throws Error if URI format is invalid
 *
 * @example
 * extractResourceUriFromAnnotationUri("https://api.semiont.app/resources/doc-123/annotations/anno-456")
 * // => "https://api.semiont.app/resources/doc-123"
 */
export function extractResourceUriFromAnnotationUri(annotationUri: ResourceAnnotationUri): ResourceUri {
  const parts = annotationUri.split('/annotations/');
  if (parts.length !== 2) {
    throw new Error(`Invalid annotation URI format: ${annotationUri}`);
  }
  return resourceUri(parts[0]);
}
