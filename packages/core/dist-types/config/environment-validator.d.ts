/**
 * Environment validation utilities
 *
 * Pure functions - accept available environments as parameter instead of reading from filesystem
 */
export type Environment = string;
/**
 * Type guard to check if a string is a valid Environment
 * @param value - The environment string to check
 * @param availableEnvironments - List of valid environment names
 */
export declare function isValidEnvironment(value: string | undefined, availableEnvironments: string[]): value is Environment;
/**
 * Parse environment string to Environment type
 * @param value - The environment string to parse
 * @param availableEnvironments - List of valid environment names
 * @returns Valid Environment type
 * @throws Error if environment is invalid or not provided
 */
export declare function parseEnvironment(value: string | undefined, availableEnvironments: string[]): Environment;
/**
 * Validate and return environment or throw error
 * @param value - The environment string to validate
 * @param availableEnvironments - List of valid environment names
 * @throws Error if environment is invalid
 */
export declare function validateEnvironment(value: string | undefined, availableEnvironments: string[]): Environment;
