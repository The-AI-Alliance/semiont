/**
 * Platform Types Module
 *
 * Re-exports PlatformType from schema-generated types.
 * Platforms represent WHERE services run (infrastructure targets).
 */

import { PlatformType as SchemaPlatformType } from './config.types.js';

/**
 * Platform type literals from JSON Schema
 * These represent the infrastructure targets where services can be deployed
 */
export type PlatformType = SchemaPlatformType;

/**
 * Type guard to check if a string is a valid platform type
 *
 * @param value - Value to check
 * @returns True if value is a valid PlatformType
 */
export function isValidPlatformType(value: string): value is PlatformType {
  return ['aws', 'container', 'posix', 'external'].includes(value);
}

/**
 * Get all valid platform types
 *
 * @returns Array of all platform types
 */
export function getAllPlatformTypes(): PlatformType[] {
  return ['aws', 'container', 'posix', 'external'];
}