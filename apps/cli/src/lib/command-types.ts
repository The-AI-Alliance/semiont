/**
 * Command Type Definitions - Standard interfaces for CLI commands
 * 
 * This module defines the standard function signature that all
 * CLI commands must follow.
 */

import type { ServiceDeploymentInfo } from './deployment-resolver.js';
import type { CommandResults } from './command-results.js';

/**
 * Standard command function signature for all commands.
 * 
 * All commands receive pre-resolved services as the first parameter
 * and command-specific options as the second parameter.
 * 
 * @param serviceDeployments - Pre-resolved array of service deployment configurations
 * @param options - Command-specific options (must extend BaseCommandOptions)
 * @returns Promise of structured command results
 */
export type CommandFunction<TOptions = any> = (
  serviceDeployments: ServiceDeploymentInfo[],
  options: TOptions
) => Promise<CommandResults>;

// Re-export BaseCommandOptions for backward compatibility
export type { BaseCommandOptions } from './base-command-options.js';