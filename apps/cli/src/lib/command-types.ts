/**
 * Command Type Definitions - Standard interfaces for CLI commands
 * 
 * This module defines the standard function signature that all
 * CLI commands must follow.
 */

import type { ServicePlatformInfo } from './platform-resolver.js';
import type { CommandResults } from './command-results.js';

/**
 * Standard command function signature for all commands.
 * 
 * All commands receive pre-resolved services as the first parameter
 * and command-specific options as the second parameter.
 * 
 * @template TOptions - The type of command-specific options
 * @template TResult - The type of service-specific results (defaults to ServiceResult)
 * 
 * @param serviceDeployments - Pre-resolved array of service deployment configurations
 * @param options - Command-specific options
 * @returns Promise of structured command results with preserved service types
 */
export type CommandFunction<TOptions = any, TResult = any> = (
  serviceDeployments: ServicePlatformInfo[],
  options: TOptions
) => Promise<CommandResults<TResult>>;