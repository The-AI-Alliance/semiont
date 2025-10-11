import { nanoid } from 'nanoid';
import { User } from '@prisma/client';
import type { Agent } from '@semiont/core-types';

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

/**
 * Convert a User object to a DID:WEB identifier
 *
 * Format: did:web:domain.com:users:userId
 * Example: did:web:example.com:users:abc123
 *
 * This is used for W3C Web Annotation compliance and federation readiness.
 */
export function userToDid(user: Pick<User, 'id' | 'domain'>): string {
  return `did:web:${user.domain}:users:${user.id}`;
}

/**
 * Convert a User object to a W3C Agent object with DID:WEB identifier
 *
 * Creates a full Agent object for W3C Web Annotation compliance.
 * Includes DID:WEB identifier, type, and name.
 */
export function userToAgent(user: Pick<User, 'id' | 'domain' | 'name' | 'email'>): Agent {
  return {
    type: 'Person' as const,
    id: userToDid(user),
    name: user.name || user.email,
  };
}

/**
 * Convert a DID string to a minimal W3C Agent object
 *
 * Used when reconstructing annotations from events where only the DID is available.
 * Creates a minimal Agent with just the required fields (id, type).
 * Name is derived from the DID for display purposes.
 */
export function didToAgent(did: string): Agent {
  // Extract user ID from DID format: did:web:domain.com:users:userId
  const parts = did.split(':');
  const userId = parts[parts.length - 1] || 'unknown';

  return {
    type: 'Person' as const,
    id: did,
    name: userId, // Use user ID as name since we don't have full user data
  };
}
