/**
 * DID (Decentralized Identifier) and W3C Agent utilities
 *
 * Provides utilities for working with DID:WEB identifiers and converting
 * between user representations and W3C Web Annotation Agent objects.
 */

import type { components } from './types';

type Agent = components['schemas']['Agent'];

/**
 * Convert a user object to a DID:WEB identifier
 *
 * Format: did:web:domain.com:users:email%40domain.com
 * Example: did:web:example.com:users:alice%40example.com
 *
 * Email is used as the stable, human-readable identifier (URI-encoded).
 * This is used for W3C Web Annotation compliance and federation readiness.
 *
 * @param user - User object with email and domain
 * @returns DID:WEB identifier string
 */
export function userToDid(user: { email: string; domain: string }): string {
  return `did:web:${user.domain}:users:${encodeURIComponent(user.email)}`;
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
  // Extract email from DID format: did:web:domain.com:users:alice%40example.com
  const parts = did.split(':');
  const encoded = parts[parts.length - 1] || 'unknown';
  const name = decodeURIComponent(encoded);

  return {
    type: 'Person' as const,
    id: did,
    name,
  };
}
