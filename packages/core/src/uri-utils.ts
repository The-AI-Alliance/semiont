/**
 * URI utilities for W3C annotations
 *
 * Converts between short resource/annotation IDs and full URIs.
 * Full URIs are required by W3C Web Annotation Data Model.
 */

import { annotationId, resourceId, type ResourceId, type AnnotationId } from './identifiers';
import { resourceUri, annotationUri, type ResourceUri, type AnnotationUri, type ResourceAnnotationUri } from './branded-types';

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
 * Extract resource ID from a full URI or return a bare ID as-is.
 *
 * @param uriOrId - Full resource URI (e.g., "https://api.semiont.app/resources/doc-abc123") or bare ID
 * @returns Short resource ID (e.g., "doc-abc123")
 * @throws Error if URI contains `/resources/` but format is invalid
 */
export function uriToResourceId(uriOrId: string): ResourceId {
  if (!uriOrId.includes('/')) {
    return resourceId(uriOrId);
  }
  const url = new URL(uriOrId);
  const match = url.pathname.match(/\/resources\/([^/]+)/);
  if (!match || !match[1]) {
    throw new Error(`Invalid resource URI: ${uriOrId}`);
  }
  return resourceId(match[1]);
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
