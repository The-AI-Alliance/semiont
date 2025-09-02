/**
 * Command Results Type System - Aggregated results for command execution
 * 
 * This module defines the structure for aggregated command results when
 * commands operate on multiple services or need to track overall execution.
 */

import type { Platform } from './platform-resolver.js';

// Base result interface that all command results extend (for testing/mocking)
export interface BaseCommandResult {
  command: string;
  entity: string;  // The entity this result applies to (service, resource, etc.)
  service: string;
  platform: Platform;
  environment: string;
  timestamp: Date;
  success: boolean;
  duration: number; // milliseconds
  error?: string;
}

// Minimal interface that all command results must satisfy for formatting
export interface BaseResult {
  entity: string;  // The entity this result applies to (service, resource, etc.)
  success: boolean;
  error?: string;
  [key: string]: any; // Allow additional properties
}


// =====================================================================
// AGGREGATED RESULTS FOR MULTI-SERVICE OPERATIONS
// =====================================================================

// Aggregated command results structure
// Generic to preserve service-specific result types
export interface CommandResults<TResult = BaseResult> {
  command: string;
  environment: string;
  timestamp: Date;
  duration: number;
  results: TResult[];  // Command execution results
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    warnings: number;
  };
  // Metadata about the command execution
  executionContext: {
    user: string;
    workingDirectory: string;
    cliVersion?: string;
    dryRun: boolean;
  };
}

// =====================================================================
// HELPER FUNCTIONS (mainly for testing)
// =====================================================================

// Helper function to create base result
export function createBaseResult(
  command: string,
  service: string,
  platform: Platform,
  environment: string,
  startTime: number
): BaseCommandResult {
  return {
    command,
    entity: service,  // Use entity field as expected by BaseResult
    service,  // Keep service for backward compatibility
    platform,
    environment,
    timestamp: new Date(),
    success: true,
    duration: Date.now() - startTime,
  };
}

// Helper function to create error result
export function createErrorResult(
  baseResult: BaseCommandResult,
  error: Error | string
): BaseCommandResult {
  return {
    ...baseResult,
    success: false,
    error: typeof error === 'string' ? error : error.message,
  };
}