/**
 * ID generation utilities
 */

// crypto.randomUUID() is available as a global in Node 14.17+ and all modern browsers.
// Declared here because the core package tsconfig uses lib:ES2022 (no dom types).
declare const crypto: { randomUUID(): string };

/**
 * Generate a UUID v4 string (without dashes)
 */
export function generateUuid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
