/**
 * Environment validation utilities
 */

export type Environment = 'dev' | 'staging' | 'prod' | 'ci' | 'local';

const VALID_ENVIRONMENTS = ['dev', 'staging', 'prod', 'ci', 'local'] as const;

/**
 * Type guard to check if a string is a valid Environment
 */
export function isValidEnvironment(value: string | undefined): value is Environment {
  return value === 'dev' || value === 'staging' || value === 'prod' || value === 'ci' || value === 'local';
}

/**
 * Safely parse environment string to Environment type
 * @param value - The environment string to parse
 * @param defaultEnv - Default environment if value is invalid (defaults to 'dev')
 * @returns Valid Environment type
 */
export function parseEnvironment(value: string | undefined, defaultEnv: Environment = 'dev'): Environment {
  if (!value) return defaultEnv;
  return isValidEnvironment(value) ? value : defaultEnv;
}

/**
 * Validate and return environment or throw error
 * @param value - The environment string to validate
 * @throws Error if environment is invalid
 */
export function validateEnvironment(value: string | undefined): Environment {
  if (!value) {
    throw new Error('Environment is required');
  }
  if (!isValidEnvironment(value)) {
    throw new Error(`Invalid environment: ${value}. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`);
  }
  return value;
}