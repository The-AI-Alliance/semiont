/**
 * Unified Command Result Types
 * 
 * Provides a generic command result structure with command-specific extensions.
 * This replaces the various command-specific result types (StartResult, UpdateResult, etc.)
 * with a single extensible type that all commands can use.
 */

import { ServiceName } from './service-discovery.js';
import { PlatformType } from '@semiont/core';
import { PlatformResources } from '../platforms/platform-resources.js';

/**
 * Generic command result with command-specific extensions
 */
export interface CommandMetadata {
  // Service classification
  serviceType?: string;
  agent?: string;
  port?: number;

  // Execution state
  skipped?: boolean;
  reason?: string;
  preflight?: boolean;
  checks?: unknown;
  stateVerified?: boolean;
  stateMismatch?: boolean;
  errorType?: string;
  errorStack?: string;

  // AWS identifiers
  awsRegion?: string;
  ecsServiceName?: string;
  ecsClusterName?: string;
  rdsInstanceId?: string;
  efsFileSystemId?: string;
  cloudFormationStackName?: string;
  logGroupName?: string;
  loadBalancerDns?: string;
  albArn?: string;
  wafWebAclId?: string;
  taskArn?: string;

  // Container/proxy health check
  healthCheck?: {
    containerId?: string;
    uptime?: string;
    frontendRouting?: boolean;
    backendRouting?: boolean;
    adminHealthy?: boolean;
  };
}

export interface HealthDetails {
  // Connection evidence
  address?: string;
  protocolVersion?: string;

  // HTTP evidence
  endpoint?: string;
  statusCode?: number;
  status?: number | string;
  port?: number;
  health?: unknown;

  // Generic error/message fields
  error?: string;
  message?: string;
  contentType?: string | null;
  connections?: number;
  activeQueries?: number;

  // Inference evidence
  model?: string;
  responseTime?: number | string;
  responsePreview?: string;
  modelAvailability?: Record<string, boolean>;

  // Process evidence
  pid?: number;
  process?: { memory?: string };

  // ECS evidence
  revision?: number;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  taskDefinition?: string;
  deploymentStatus?: string;

  // EFS evidence
  storageUsedBytes?: number;
  storageUsedStandard?: number;
  storageUsedIA?: number;
  provisionedThroughputInMibps?: number;
  numberOfMountTargets?: number;

  // CPU/memory/uptime metrics
  cpu?: number;
  memory?: number;
  uptime?: number;
}

export interface CommandResult {
  // Core fields present in all results
  entity: ServiceName;
  platform: PlatformType;
  success: boolean;
  timestamp: Date;
  error?: string;
  metadata?: CommandMetadata;

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
  
  // stop command extensions
  stop?: {
    stopTime?: Date;
    graceful?: boolean;
  };
  
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
    details: HealthDetails;
  };
  logs?: {
    recent: string[];
    errors: string[];
  };
  dependencies?: CommandResult[];  // For deep checking
  
  // provision command extensions
  provisionedResources?: string[];
  stackOutputs?: Record<string, string>;
  
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