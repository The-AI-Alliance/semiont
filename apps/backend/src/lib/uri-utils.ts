/**
 * URI utilities for W3C annotations
 *
 * Converts between short resource/annotation IDs and full URIs.
 * Full URIs are required by W3C Web Annotation Data Model.
 */

import { getBackendConfig } from '../config/environment-loader';
import { resourceId, annotationId, type ResourceId, type AnnotationId } from '@semiont/core';

/**
 * Convert resource ID to full URI
 *
 * @param resourceId - Short resource ID (e.g., "doc-abc123")
 * @returns Full URI (e.g., "https://api.semiont.app/resources/doc-abc123")
 *
 * @example
 * resourceIdToURI("doc-abc123")
 * // => "https://api.semiont.app/resources/doc-abc123"
 */
export function resourceIdToURI(resourceId: string): string {
  const baseURL = getBackendConfig().publicURL;
  // Remove trailing slash if present
  const normalizedBase = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
  return `${normalizedBase}/resources/${resourceId}`;
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
 * @param annotationId - Short annotation ID (e.g., "anno-xyz789")
 * @returns Full URI (e.g., "https://api.semiont.app/annotations/anno-xyz789")
 *
 * @example
 * annotationIdToURI("anno-xyz789")
 * // => "https://api.semiont.app/annotations/anno-xyz789"
 */
export function annotationIdToURI(annotationId: string): string {
  const baseURL = getBackendConfig().publicURL;
  // Remove trailing slash if present
  const normalizedBase = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
  return `${normalizedBase}/annotations/${annotationId}`;
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
