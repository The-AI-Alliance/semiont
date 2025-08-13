/**
 * Command Results Type System - Structured output interfaces for all commands
 * 
 * This module defines the complete type hierarchy for structured command outputs
 * across all service/command/deployment-type combinations.
 */

// Base result interface that all command results extend
export interface BaseCommandResult {
  command: string;
  service: string;
  deploymentType: 'aws' | 'container' | 'process' | 'external' | 'mock';
  environment: string;
  timestamp: Date;
  success: boolean;
  duration: number; // milliseconds
  error?: string;
}

// Resource identifiers for different deployment types
export interface ResourceIdentifier {
  aws?: { arn?: string; id?: string; name?: string };
  container?: { id?: string; name?: string };
  process?: { pid?: number; port?: number; path?: string };
  external?: { endpoint?: string; path?: string };
  mock?: { id?: string; name?: string };
}

// Base service result that includes resource identification
export interface ServiceResult extends BaseCommandResult {
  resourceId: ResourceIdentifier;
  status: string;
  metadata: Record<string, any>;
}

// =====================================================================
// COMMAND-SPECIFIC RESULT TYPES
// =====================================================================

export interface StartResult extends ServiceResult {
  startTime: Date;
  endpoint?: string;
  healthCheck?: {
    status: 'healthy' | 'unhealthy' | 'unknown';
    responseTime?: number;
  };
}

export interface StopResult extends ServiceResult {
  stopTime: Date;
  gracefulShutdown: boolean;
  forcedTermination?: boolean;
}

export interface RestartResult extends ServiceResult {
  stopTime: Date;
  startTime: Date;
  downtime: number; // milliseconds
  gracefulRestart: boolean;
}

export interface ProvisionResult extends ServiceResult {
  resources: Array<{
    type: string;
    id: string;
    arn?: string;
    status: string;
    metadata?: Record<string, any>;
  }>;
  dependencies: string[];
  estimatedCost?: {
    hourly: number;
    monthly: number;
    currency: string;
  };
}

export interface ConfigureResult extends ServiceResult {
  configurationChanges: Array<{
    key: string;
    oldValue?: any;
    newValue: any;
    source: string;
  }>;
  restartRequired: boolean;
}

export interface PublishResult extends ServiceResult {
  imageTag?: string;
  imageSize?: number;
  buildDuration: number;
  repository?: string;
  digest?: string;
}

export interface UpdateResult extends ServiceResult {
  updateTime: Date;
  previousVersion?: string;
  newVersion?: string;
  rollbackAvailable: boolean;
  changesApplied: Array<{
    type: 'code' | 'config' | 'dependencies' | 'infrastructure';
    description: string;
  }>;
}

export interface CheckResult extends ServiceResult {
  healthStatus: 'healthy' | 'unhealthy' | 'degraded' | 'unknown';
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'warn';
    message: string;
    responseTime?: number;
    details?: Record<string, any>;
  }>;
  uptime?: number; // seconds
  lastCheck: Date;
}

export interface WatchResult extends ServiceResult {
  watchType: 'logs' | 'metrics' | 'events';
  streamUrl?: string;
  logLines?: Array<{
    timestamp: Date;
    level: string;
    message: string;
    source?: string;
  }>;
  metrics?: Array<{
    name: string;
    value: number;
    unit: string;
    timestamp: Date;
  }>;
}

export interface TestResult extends ServiceResult {
  testSuite: string;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  testDuration: number;
  coverage?: {
    lines: number;
    functions: number;
    branches: number;
    statements: number;
  };
  failures: Array<{
    test: string;
    error: string;
    stack?: string;
  }>;
}

export interface ExecResult extends ServiceResult {
  command: string;
  exitCode: number;
  output?: string;
  error?: string;
  interactive: boolean;
  executionTime: number;
}

export interface BackupResult extends ServiceResult {
  backupName: string;
  backupSize: number; // bytes
  backupLocation: string;
  backupType: 'full' | 'incremental' | 'differential';
  compressed: boolean;
  retentionPolicy?: string;
  estimatedRestoreTime?: number; // minutes
}

// =====================================================================
// DEPLOYMENT-TYPE SPECIFIC EXTENSIONS
// =====================================================================

// AWS-specific result extensions
export interface AWSServiceResult extends Omit<ServiceResult, 'resourceId'> {
  resourceId: {
    aws: { arn: string; id: string; name: string };
  };
  awsRegion: string;
  awsAccount?: string;
  tags?: Record<string, string>;
}

export interface AWSStartResult extends Omit<StartResult, 'resourceId'>, AWSServiceResult {
  taskDefinitionArn?: string;
  clusterName?: string;
  serviceArn?: string;
  targetGroup?: string;
}

export interface AWSProvisionResult extends Omit<ProvisionResult, 'resourceId'>, AWSServiceResult {
  cloudFormationStack?: string;
  resources: Array<{
    type: string;
    id: string;
    arn: string;
    status: string;
    metadata?: Record<string, any>;
  }>;
}

// Container-specific result extensions
export interface ContainerServiceResult extends Omit<ServiceResult, 'resourceId'> {
  resourceId: {
    container: { id: string; name: string };
  };
  containerRuntime: 'docker' | 'podman';
  image: string;
  ports?: Record<string, string>;
  volumes?: string[];
}

export interface ContainerStartResult extends Omit<StartResult, 'resourceId'>, ContainerServiceResult {
  networkMode?: string;
  mountPoints?: Array<{
    source: string;
    destination: string;
    readOnly: boolean;
  }>;
}

// Process-specific result extensions
export interface ProcessServiceResult extends ServiceResult {
  resourceId: {
    process: { pid: number; port?: number; path: string };
  };
  workingDirectory: string;
  processCommand: string;
  processArguments?: string[];
  processEnvironment?: Record<string, string>;
}

// External service result extensions
export interface ExternalServiceResult extends ServiceResult {
  resourceId: {
    external: { endpoint?: string; path?: string };
  };
  provider?: string;
  accessMethod: 'api' | 'web' | 'cli' | 'manual';
  documentation?: string;
}

// =====================================================================
// AGGREGATED RESULTS FOR MULTI-SERVICE OPERATIONS
// =====================================================================

export interface CommandResults {
  command: string;
  environment: string;
  timestamp: Date;
  duration: number;
  services: ServiceResult[];
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
// UTILITY TYPES AND HELPERS
// =====================================================================

// Union type of all possible service results
export type AnyServiceResult = 
  | StartResult 
  | StopResult 
  | RestartResult 
  | ProvisionResult 
  | ConfigureResult 
  | PublishResult 
  | UpdateResult 
  | CheckResult 
  | WatchResult 
  | TestResult 
  | ExecResult 
  | BackupResult;

// Union type of all deployment-type specific results
export type AnyDeploymentResult = 
  | AWSServiceResult 
  | ContainerServiceResult 
  | ProcessServiceResult 
  | ExternalServiceResult;

// Helper type to extract result type by command name
export type ResultByCommand<T extends string> = 
  T extends 'start' ? StartResult :
  T extends 'stop' ? StopResult :
  T extends 'restart' ? RestartResult :
  T extends 'provision' ? ProvisionResult :
  T extends 'configure' ? ConfigureResult :
  T extends 'publish' ? PublishResult :
  T extends 'update' ? UpdateResult :
  T extends 'check' ? CheckResult :
  T extends 'watch' ? WatchResult :
  T extends 'test' ? TestResult :
  T extends 'exec' ? ExecResult :
  T extends 'backup' ? BackupResult :
  ServiceResult;

// Helper function to create base result
export function createBaseResult(
  command: string,
  service: string,
  deploymentType: 'aws' | 'container' | 'process' | 'external' | 'mock',
  environment: string,
  startTime: number
): BaseCommandResult {
  return {
    command,
    service,
    deploymentType,
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

// Type guards for deployment-specific results
export function isAWSResult(result: ServiceResult): result is AWSServiceResult {
  return result.deploymentType === 'aws' && !!result.resourceId.aws;
}

export function isContainerResult(result: ServiceResult): result is ContainerServiceResult {
  return result.deploymentType === 'container' && !!result.resourceId.container;
}

export function isProcessResult(result: ServiceResult): result is ProcessServiceResult {
  return result.deploymentType === 'process' && !!result.resourceId.process;
}

export function isExternalResult(result: ServiceResult): result is ExternalServiceResult {
  return result.deploymentType === 'external' && !!result.resourceId.external;
}