/**
 * Environment validation utilities
 */

import { getAvailableEnvironments } from './environment-loader';

export type Environment = string; // Allow any environment name discovered from filesystem

/**
 * Type guard to check if a string is a valid Environment
 */
export function isValidEnvironment(value: string | undefined): value is Environment {
  if (!value) return false;
  // Use dynamic check from filesystem to support custom environments like 'production'
  return getAvailableEnvironments().includes(value);
}

/**
 * Parse environment string to Environment type
 * @param value - The environment string to parse
 * @returns Valid Environment type
 * @throws Error if environment is invalid or not provided
 */
export function parseEnvironment(value: string | undefined): Environment {
  if (!value) {
    throw new Error('Environment is required');
  }
  if (!isValidEnvironment(value)) {
    const availableEnvs = getAvailableEnvironments();
    throw new Error(`Invalid environment: ${value}. Available environments: ${availableEnvs.join(', ')}`);
  }
  return value;
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
    const availableEnvs = getAvailableEnvironments();
    throw new Error(`Invalid environment: ${value}. Available environments: ${availableEnvs.join(', ')}`);
  }
  return value;
}