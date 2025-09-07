/**
 * Command Descriptor
 * 
 * Defines the contract for command execution within the UnifiedExecutor.
 * Each command (start, update, publish, etc.) has a descriptor that specifies
 * how to transform options, build results, and handle special cases.
 */

import { ServicePlatformInfo } from './service-resolver.js';
import { Service } from '../services/types.js';
import { Platform } from './platform.js';
import { HandlerResult } from './handlers/types.js';
import { CommandResult } from './command-result.js';

/**
 * Descriptor that defines how a command should be executed
 */
export interface CommandDescriptor<TOptions> {
  /**
   * The name of the command (e.g., 'start', 'update', 'publish')
   */
  name: string;
  
  /**
   * Transform handler result to CommandResult with extensions
   */
  buildResult: (
    handlerResult: HandlerResult,
    service: Service,
    platform: Platform,
    serviceType: string
  ) => CommandResult;
  
  /**
   * Build service configuration from command options
   */
  buildServiceConfig: (
    options: TOptions,
    serviceInfo: ServicePlatformInfo
  ) => Record<string, any>;
  
  /**
   * Extract options that should be passed to handlers
   */
  extractHandlerOptions: (options: TOptions) => Record<string, any>;
  
  /**
   * Pre-execution hook for special processing (e.g., synthetic services)
   * Returns modified service deployments
   */
  preExecute?: (
    serviceDeployments: ServicePlatformInfo[],
    options: TOptions
  ) => Promise<ServicePlatformInfo[]>;
  
  /**
   * Post-execution hook for cleanup or additional processing
   */
  postExecute?: (
    results: CommandResult[],
    options: TOptions
  ) => Promise<void>;
  
  /**
   * Validate command options before execution
   */
  validateOptions?: (options: TOptions) => void;
  
  /**
   * Default options for the command
   */
  defaultOptions?: Partial<TOptions>;
  
  /**
   * Whether to continue executing remaining services if one fails
   */
  continueOnError?: boolean;
  
  /**
   * Whether this command supports the --all flag
   */
  supportsAll?: boolean;
  
  /**
   * Custom error handler for service execution failures
   */
  handleExecutionError?: (
    error: Error,
    serviceInfo: ServicePlatformInfo,
    options: TOptions
  ) => CommandResult;
}

/**
 * Create a command descriptor with sensible defaults
 */
export function createCommandDescriptor<TOptions>(
  descriptor: CommandDescriptor<TOptions>
): CommandDescriptor<TOptions> {
  return {
    continueOnError: true,  // Default to continuing on error
    supportsAll: true,      // Most commands support --all
    ...descriptor
  };
}