/**
 * Cryptographic utilities
 */

import { createHash, randomBytes } from 'crypto';

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

/**
 * Verify content against a checksum
 * @param content The content to verify
 * @param checksum The expected checksum
 * @returns True if content matches checksum
 */
export function verifyChecksum(content: string | Buffer, checksum: string): boolean {
  return calculateChecksum(content) === checksum;
}

/**
 * Generate a random ID (12 character hex string)
 * Similar to MongoDB ObjectId but simpler
 */
export function generateId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Generate a UUID v4-like ID (without dashes)
 */
export function generateUuid(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Generate a secure random token
 * @param bytes Number of random bytes (default 32)
 * @returns Base64 encoded random token
 */
export function generateToken(bytes: number = 32): string {
  return randomBytes(bytes).toString('base64url');
}