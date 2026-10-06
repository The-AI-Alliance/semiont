/**
 * Checksum utilities for content verification
 */

import { createHash } from 'crypto';

/**
 * Calculate SHA-256 checksum of content
 * @param content The content to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function calculateChecksum(content: string | Buffer): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}
