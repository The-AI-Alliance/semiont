/**
 * Comprehensive type definitions for Semiont scripts
 * Provides type safety and prevents runtime errors
 */


// OAuth Secret types
export interface OAuthSecret {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

// Validation result types
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Command execution types
export interface CommandOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface CommandResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
}

// Re-export error types from utils for backward compatibility
export { ScriptError, ValidationError } from '@semiont/utils';

// Service types for script operations
// export type ServiceType = 'frontend' | 'backend' | 'both';
// export type DeploymentTarget = 'data' | 'app' | 'all';
export type LogMode = 'tail' | 'follow' | 'all' | 'waf';

// Utility types
export interface Awaitable<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2>;
}

// Re-export type guards from utils for backward compatibility
export { isString, isNumber, isObject } from '@semiont/utils';

export function isLogMode(value: string): value is LogMode {
  return ['tail', 'follow', 'all', 'waf'].includes(value);
}