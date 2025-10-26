import { nanoid } from 'nanoid';

// Re-export DID/Agent utilities from SDK
export { userToDid, userToAgent, didToAgent } from '@semiont/core';

/**
 * Generate a unique URI for annotations (highlights/references)
 *
 * W3C Web Annotation Data Model requires annotations to have URI identifiers.
 * This function generates full URIs based on the backend base URL.
 *
 * Format: {BACKEND_URL}/annotations/{nanoid}
 * Example: https://api.semiont.ai/annotations/abc123xyz
 *
 * Uses nanoid for URL-safe, collision-resistant IDs.
 *
 * @throws Error if BACKEND_URL environment variable is not set
 */
export function generateAnnotationId(): string {
  const baseUrl = process.env.BACKEND_URL;
  if (!baseUrl) {
    throw new Error('BACKEND_URL environment variable is required to generate annotation URIs');
  }
  // Remove trailing slash if present
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}/annotations/${nanoid(21)}`;
}

/**
 * Generate a unique ID for documents
 *
 * NOTE: For documents, we use content-addressable IDs (doc-sha256:...) which
 * are generated via calculateChecksum(). This function is for future use cases
 * where we might need non-content-addressable document IDs.
 */
export function generateDocumentId(): string {
  return `doc-${nanoid(21)}`;
}
