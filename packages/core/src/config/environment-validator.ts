/**
 * Environment validation utilities
 *
 * Pure functions - accept available environments as parameter instead of reading from filesystem
 */

export type Environment = string; // Allow any environment name

/**
 * Type guard to check if a string is a valid Environment
 * @param value - The environment string to check
 * @param availableEnvironments - List of valid environment names
 */
export function isValidEnvironment(value: string | undefined, availableEnvironments: string[]): value is Environment {
  if (!value) return false;
  return availableEnvironments.includes(value);
}

/**
 * Parse environment string to Environment type
 * @param value - The environment string to parse
 * @param availableEnvironments - List of valid environment names
 * @returns Valid Environment type
 * @throws Error if environment is invalid or not provided
 */
export function parseEnvironment(value: string | undefined, availableEnvironments: string[]): Environment {
  if (!value) {
    throw new Error('Environment is required');
  }
  if (!isValidEnvironment(value, availableEnvironments)) {
    throw new Error(`Invalid environment: ${value}. Available environments: ${availableEnvironments.join(', ')}`);
  }
  return value;
}

/**
 * Validate and return environment or throw error
 * @param value - The environment string to validate
 * @param availableEnvironments - List of valid environment names
 * @throws Error if environment is invalid
 */
export function validateEnvironment(value: string | undefined, availableEnvironments: string[]): Environment {
  if (!value) {
    throw new Error('Environment is required');
  }
  if (!isValidEnvironment(value, availableEnvironments)) {
    throw new Error(`Invalid environment: ${value}. Available environments: ${availableEnvironments.join(', ')}`);
  }
  return value;
}