/**
 * DID (Decentralized Identifier) and W3C Agent utilities
 *
 * Provides utilities for working with DID:WEB identifiers and converting
 * between user representations and W3C Web Annotation Agent objects.
 */

import type { components } from '@semiont/api-client';

type Agent = components['schemas']['Agent'];

/**
 * Convert a user object to a DID:WEB identifier
 *
 * Format: did:web:domain.com:users:userId
 * Example: did:web:example.com:users:abc123
 *
 * This is used for W3C Web Annotation compliance and federation readiness.
 *
 * @param user - User object with id and domain
 * @returns DID:WEB identifier string
 */
export function userToDid(user: { id: string; domain: string }): string {
  return `did:web:${user.domain}:users:${user.id}`;
}

/**
 * Convert a user object to a W3C Agent object with DID:WEB identifier
 *
 * Creates a full Agent object for W3C Web Annotation compliance.
 * Includes DID:WEB identifier, type, and name.
 *
 * @param user - User object with id, domain, name, and email
 * @returns W3C Agent object
 */
export function userToAgent(user: {
  id: string;
  domain: string;
  name: string | null;
  email: string;
}): Agent {
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
 *
 * @param did - DID:WEB identifier string
 * @returns Minimal W3C Agent object
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
