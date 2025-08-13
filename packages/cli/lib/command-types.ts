/**
 * Command Type Definitions - Standard interfaces for CLI commands
 * 
 * This module defines the standard function signature and types that all
 * CLI commands must follow after the service resolution migration.
 */

import type { ServiceDeploymentInfo } from './deployment-resolver.js';
import type { CommandResults } from './command-results.js';

/**
 * Standard command function signature for all migrated commands.
 * 
 * All commands receive pre-resolved services as the first parameter
 * and command-specific options as the second parameter.
 * 
 * @param serviceDeployments - Pre-resolved array of service deployment configurations
 * @param options - Command-specific options (must extend BaseCommandOptions)
 * @returns Promise of structured command results
 */
export type CommandFunction<TOptions = BaseCommandOptions> = (
  serviceDeployments: ServiceDeploymentInfo[],
  options: TOptions
) => Promise<CommandResults>;

/**
 * Base options that all commands must support
 */
export interface BaseCommandOptions {
  environment: string;
  verbose?: boolean;
  dryRun?: boolean;
  output: 'summary' | 'table' | 'json' | 'yaml';
}

/**
 * Type guard to check if a function follows the standard command pattern
 */
export function isStandardCommand<T extends BaseCommandOptions>(
  fn: unknown
): fn is CommandFunction<T> {
  return typeof fn === 'function' && fn.length === 2;
}

/**
 * Command registry entry for dynamic command loading
 */
export interface CommandRegistryEntry<TOptions extends BaseCommandOptions = BaseCommandOptions> {
  name: string;
  description: string;
  command: CommandFunction<TOptions>;
  requiresServices: boolean; // Some commands like 'init' don't need services
}

/**
 * Type for the command module exports
 * Each command module should export at least these members
 */
export interface CommandModule<TOptions extends BaseCommandOptions = BaseCommandOptions> {
  // Allow any property to support both command functions and schemas
  [key: string]: CommandFunction<TOptions> | unknown;
}

/**
 * Helper type to extract options type from a command function
 */
export type CommandOptions<T> = T extends CommandFunction<infer TOptions> ? TOptions : never;

/**
 * Helper type to ensure type safety when creating command implementations
 */
export function defineCommand<TOptions extends BaseCommandOptions>(
  implementation: CommandFunction<TOptions>
): CommandFunction<TOptions> {
  return implementation;
}