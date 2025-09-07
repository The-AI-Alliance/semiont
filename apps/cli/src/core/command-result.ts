/**
 * Unified Command Result Types
 * 
 * Provides a generic command result structure with command-specific extensions.
 * This replaces the various command-specific result types (StartResult, UpdateResult, etc.)
 * with a single extensible type that all commands can use.
 */

import { ServiceName } from './service-discovery.js';
import { PlatformType } from './platform-types.js';
import { PlatformResources } from '../platforms/platform-resources.js';

/**
 * Generic command result with command-specific extensions
 */
export interface CommandResult {
  // Core fields present in all results
  entity: ServiceName;
  platform: PlatformType;
  success: boolean;
  timestamp: Date;
  error?: string;
  metadata?: Record<string, any>;
  
  // Command-specific extensions
  extensions?: CommandExtensions;
}

/**
 * Command-specific extensions for results
 */
export interface CommandExtensions {
  // start command extensions
  startTime?: Date;
  endpoint?: string;
  resources?: PlatformResources;
  
  // update command extensions
  previousVersion?: string;
  newVersion?: string;
  strategy?: 'rolling' | 'recreate' | 'none';
  downtime?: number;
  
  // publish command extensions
  version?: string;
  artifacts?: Record<string, string>;
  rollback?: {
    supported: boolean;
    command?: string;
  };
  registry?: {
    type: string;
    uri: string;
    tags: string[];
  };
  
  // check command extensions
  status?: 'running' | 'stopped' | 'unknown';
  health?: {
    healthy: boolean;
    details: Record<string, any>;
  };
  logs?: {
    recent: string[];
    errors: string[];
  };
  dependencies?: CommandResult[];  // For deep checking
  
  // provision command extensions
  provisionedResources?: string[];
  stackOutputs?: Record<string, any>;
  
  // stop command extensions
  stoppedAt?: Date;
  gracefulShutdown?: boolean;
  
  // restart command extensions
  restartCount?: number;
  restartStrategy?: 'stop-start' | 'rolling' | 'immediate';
}

/**
 * Type guard to check if a result has specific extensions
 */
export function hasExtension<K extends keyof CommandExtensions>(
  result: CommandResult,
  extension: K
): result is CommandResult & { extensions: Required<Pick<CommandExtensions, K>> } {
  return result.extensions !== undefined && extension in result.extensions;
}

/**
 * Create a command result with type safety
 */
export function createCommandResult(
  base: Omit<CommandResult, 'timestamp'>,
  extensions?: CommandExtensions
): CommandResult {
  return {
    ...base,
    timestamp: new Date(),
    extensions
  };
}