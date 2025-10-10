import { nanoid } from 'nanoid';
import { User } from '@prisma/client';

/**
 * Generate a unique ID for annotations (highlights/references)
 *
 * This is a backend-internal ID generation utility that does NOT depend on
 * any graph database. Each graph implementation (Neo4j, JanusGraph, Neptune, etc.)
 * can do whatever they need internally, but our Layer 2/3 architecture uses
 * these IDs as the canonical identifiers.
 *
 * Uses nanoid for URL-safe, collision-resistant IDs.
 */
export function generateAnnotationId(): string {
  return `ann-${nanoid(21)}`;
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
