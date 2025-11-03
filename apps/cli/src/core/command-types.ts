/**
 * Command Type Definitions
 * 
 * Pure type definitions for command functions.
 * This module contains ONLY type definitions with no behavior.
 */

import type { ServicePlatformInfo } from './service-resolver.js';

/**
 * Command results for aggregated operations
 */
export interface CommandResults<TResult = any> {
  command: string;
  environment: string;
  timestamp: Date;
  duration: number;
  results: TResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    warnings: number;
  };
  executionContext: {
    user: string;
    workingDirectory: string;
    cliVersion?: string;
    dryRun: boolean;
  };
}

/**
 * Standard command function signature for service-based commands.
 *
 * Service-based commands receive:
 * 1. Pre-resolved services
 * 2. Command-specific options
 * 3. Environment configuration (includes projectRoot in _metadata)
 */
export type ServiceCommandFunction<TOptions = any, TResult = any> = (
  serviceDeployments: ServicePlatformInfo[],
  options: TOptions,
  envConfig: import('@semiont/core').EnvironmentConfig
) => Promise<CommandResults<TResult>>;

/**
 * Command function signature for commands that don't require services.
 * 
 * Setup and configuration commands only receive options.
 */
export type SetupCommandFunction<TOptions = any, TResult = any> = (
  options: TOptions
) => Promise<CommandResults<TResult>>;

/**
 * Union type for all command functions.
 * Commands can either be service-based or setup-only.
 */
export type CommandFunction<TOptions = any, TResult = any> = 
  | ServiceCommandFunction<TOptions, TResult>
  | SetupCommandFunction<TOptions, TResult>;