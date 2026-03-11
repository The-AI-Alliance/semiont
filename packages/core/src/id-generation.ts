/**
 * ID generation utilities
 */

import { randomBytes } from 'crypto';

/**
 * Generate a UUID v4-like ID (without dashes)
 */
export function generateUuid(): string {
  return randomBytes(16).toString('hex');
}
