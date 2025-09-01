
/**
 * Command Type Definitions → Type definitions only
 * 
 * This module contains ONLY type definitions and minimal constants.
 * It answers the fundamental question: "What shape should things have?"
 * 
 * Contents:
 * - Type definitions for command functions
 * - Core platform command constants (used by handlers)
 * - No behavior, no discovery logic, no business rules
 * 
 * Why this exists:
 * - Provides TypeScript type safety across the codebase
 * - Defines contracts that commands and handlers must follow
 * - Avoids circular dependencies by being a leaf module
 * 
 * This module should NEVER import from other modules in core/
 * (except other pure type modules like command-results.ts)
 */

import type { ServicePlatformInfo } from './platform-resolver.js';
import type { CommandResults } from './command-results.js';

/**
 * Core platform commands that most platforms implement.
 * These are the commands that have handlers in the platform strategies.
 */
export const CORE_PLATFORM_COMMANDS = [
  'check',
  'start',
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