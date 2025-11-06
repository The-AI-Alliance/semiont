import { nanoid } from 'nanoid';

// Re-export DID/Agent utilities from SDK
export { userToDid, userToAgent, didToAgent } from '@semiont/core';

/**
 * Generate a unique URI for annotations (highlights/references)
 *
 * W3C Web Annotation Data Model requires annotations to have URI identifiers.
 * This function generates full URIs based on the backend base URL.
 *
 * Format: {baseUrl}/annotations/{nanoid}
 * Example: https://api.semiont.ai/annotations/abc123xyz
 *
 * Uses nanoid for URL-safe, collision-resistant IDs.
 *
 * @param baseUrl - Backend public URL from config
 * @throws Error if baseUrl is not provided
 */
export function generateAnnotationId(baseUrl: string): string {
  if (!baseUrl) {
    throw new Error('baseUrl is required to generate annotation URIs');
  }
  // Remove trailing slash if present
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}/annotations/${nanoid(21)}`;
}

/**
 * Generate a unique ID for resources
 *
 * NOTE: For resources, we use content-addressable IDs (doc-sha256:...) which
 * are generated via calculateChecksum(). This function is for future use cases
 * where we might need non-content-addressable resource IDs.
 */
export function generateResourceId(): string {
  return `doc-${nanoid(21)}`;
}
