/**
 * Platform Types Module
 * 
 * Defines the platform type literals used throughout the system.
 * Platforms represent WHERE services run (infrastructure targets).
 */

/**
 * Platform type literals
 * These represent the infrastructure targets where services can be deployed
 */
export type PlatformType = 'aws' | 'container' | 'posix' | 'external' | 'mock';

/**
 * Type guard to check if a string is a valid platform type
 * 
 * @param value - Value to check
 * @returns True if value is a valid PlatformType
 */
export function isValidPlatformType(value: string): value is PlatformType {
  return ['aws', 'container', 'posix', 'external', 'mock'].includes(value);
}

/**
 * Get all valid platform types
 * 
 * @returns Array of all platform types
 */
export function getAllPlatformTypes(): PlatformType[] {
  return ['aws', 'container', 'posix', 'external', 'mock'];
}