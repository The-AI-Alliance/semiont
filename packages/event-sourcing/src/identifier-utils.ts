/**
 * Identifier utilities for event sourcing
 */

import { nanoid } from 'nanoid';

/**
 * Generate a unique annotation ID (bare nanoid)
 *
 * @returns A bare annotation ID (e.g., "V1StGXR8_Z5jdHi6B-myT")
 */
export function generateAnnotationId(): string {
  return nanoid(21);
}
