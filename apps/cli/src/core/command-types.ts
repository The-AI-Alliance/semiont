/**
 * Command Type Definitions - Standard interfaces for CLI commands
 * 
 * This module defines the standard function signature that all
 * CLI commands must follow.
 */

import type { ServicePlatformInfo } from './platform-resolver.js';
import type { CommandResults } from './command-results.js';

/**
 * All available CLI commands as a const array
 */
export const COMMANDS = [
  'check',
  'start', 
  'stop',
  'update',
  'provision',
  'publish',
  'init',
  'configure',
  'backup',
  'restore',
  'exec',
  'watch',
  'restart',
  'test',
  'provision-cdk'
] as const;

/**
 * Type representing any valid command name
 */
export type CommandName = typeof COMMANDS[number];

/**
 * Core platform commands that most platforms implement
 */
export const CORE_PLATFORM_COMMANDS = [
  'check',
  'start',
  'stop',
  'update',
  'provision',
  'publish'
] as const;

/**
 * Type for core platform commands
 */
export type CorePlatformCommand = typeof CORE_PLATFORM_COMMANDS[number];

/**
 * Standard command function signature for service-based commands.
 * 
 * Service-based commands receive pre-resolved services as the first parameter
 * and command-specific options as the second parameter.
 * 
 * @template TOptions - The type of command-specific options
 * @template TResult - The type of service-specific results (defaults to ServiceResult)
 * 
 * @param serviceDeployments - Pre-resolved array of service deployment configurations
 * @param options - Command-specific options
 * @returns Promise of structured command results with preserved service types
 */
export type ServiceCommandFunction<TOptions = any, TResult = any> = (
  serviceDeployments: ServicePlatformInfo[],
  options: TOptions
) => Promise<CommandResults<TResult>>;

/**
 * Command function signature for commands that don't require services.
 * 
 * Setup and configuration commands only receive options.
 * 
 * @template TOptions - The type of command-specific options
 * @template TResult - The type of command results
 * 
 * @param options - Command-specific options
 * @returns Promise of structured command results
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