/**
 * URI utilities for W3C annotations
 *
 * Converts between short document/annotation IDs and full URIs.
 * Full URIs are required by W3C Web Annotation Data Model.
 */

import { getBackendConfig } from '../config/environment-loader';

/**
 * Convert document ID to full URI
 *
 * @param documentId - Short document ID (e.g., "doc-abc123")
 * @returns Full URI (e.g., "https://api.semiont.app/documents/doc-abc123")
 *
 * @example
 * documentIdToURI("doc-abc123")
 * // => "https://api.semiont.app/documents/doc-abc123"
 */
export function documentIdToURI(documentId: string): string {
  const baseURL = getBackendConfig().publicURL;
  // Remove trailing slash if present
  const normalizedBase = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
  return `${normalizedBase}/documents/${documentId}`;
}

/**
 * Extract document ID from full URI
 *
 * @param uri - Full document URI (e.g., "https://api.semiont.app/documents/doc-abc123")
 * @returns Short document ID (e.g., "doc-abc123")
 * @throws Error if URI format is invalid
 *
 * @example
 * uriToDocumentId("https://api.semiont.app/documents/doc-abc123")
 * // => "doc-abc123"
 */
export function uriToDocumentId(uri: string): string {
  const url = new URL(uri);
  const match = url.pathname.match(/\/documents\/([^/]+)/);
  if (!match) {
    throw new Error(`Invalid document URI: ${uri}`);
  }
  return match[1];
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
export function uriToAnnotationId(uri: string): string {
  const url = new URL(uri);
  const match = url.pathname.match(/\/annotations\/([^/]+)/);
  if (!match) {
    throw new Error(`Invalid annotation URI: ${uri}`);
  }
  return match[1];
}
