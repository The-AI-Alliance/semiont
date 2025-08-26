/**
 * Platform Strategy Interface
 * 
 * Defines how services are managed across different deployment platforms.
 * Each platform (process, container, AWS, external) implements this interface
 * to provide platform-specific behavior for common operations.
 */

import { 
  ServiceName, 
  Environment,
  StartResult, 
  StopResult, 
  CheckResult, 
  UpdateResult,
  ProvisionResult,
  PublishResult,
  BackupResult,
  ExecResult,
  ExecOptions,
  TestResult,
  TestOptions,
  RestoreResult,
  RestoreOptions,
  ServiceConfig 
} from '../services/types.js';

/**
 * Service context provided to platform strategies
 * Contains service-specific information needed for platform operations
 */
export interface ServiceContext {
  name: ServiceName;
  config: ServiceConfig;
  environment: Environment;
  projectRoot: string;
  verbose: boolean;
  quiet: boolean;
  dryRun?: boolean;
  
  // Service-specific methods that platforms can call
  getPort(): number;
  getHealthEndpoint(): string;
  getCommand(): string;
  getImage(): string;
  getEnvironmentVariables(): Record<string, string>;
}

/**
 * Platform strategy interface
 * Implemented by each deployment platform (process, container, AWS, external)
 */
export interface PlatformStrategy {
  /**
   * Start a service on this platform
   */
  start(context: ServiceContext): Promise<StartResult>;
  
  /**
   * Stop a service on this platform
   */
  stop(context: ServiceContext): Promise<StopResult>;
  
  /**
   * Check the status of a service on this platform
   */
  check(context: ServiceContext): Promise<CheckResult>;
  
  /**
   * Update a service on this platform
   */
  update(context: ServiceContext): Promise<UpdateResult>;
  
  /**
   * Provision infrastructure and resources for a service on this platform
   */
  provision(context: ServiceContext): Promise<ProvisionResult>;
  
  /**
   * Publish artifacts and deploy service content on this platform
   */
  publish(context: ServiceContext): Promise<PublishResult>;
  
  /**
   * Backup service data and state on this platform
   */
  backup(context: ServiceContext): Promise<BackupResult>;
  
  /**
   * Execute a command in the service context on this platform
   */
  exec(context: ServiceContext, command: string, options?: ExecOptions): Promise<ExecResult>;
  
  /**
   * Run tests for a service on this platform
   */
  test(context: ServiceContext, options?: TestOptions): Promise<TestResult>;
  
  /**
   * Restore service data and state from a backup on this platform
   */
  restore(context: ServiceContext, backupId: string, options?: RestoreOptions): Promise<RestoreResult>;
  
  /**
   * Collect logs from a service on this platform
   */
  collectLogs(context: ServiceContext): Promise<CheckResult['logs']>;
  
  /**
   * Get the platform name for logging
   */
  getPlatformName(): string;
}

/**
 * Base platform strategy with common functionality
 */
export abstract class BasePlatformStrategy implements PlatformStrategy {
  abstract start(context: ServiceContext): Promise<StartResult>;
  abstract stop(context: ServiceContext): Promise<StopResult>;
  abstract check(context: ServiceContext): Promise<CheckResult>;
  abstract update(context: ServiceContext): Promise<UpdateResult>;
  abstract provision(context: ServiceContext): Promise<ProvisionResult>;
  abstract publish(context: ServiceContext): Promise<PublishResult>;
  abstract backup(context: ServiceContext): Promise<BackupResult>;
  abstract exec(context: ServiceContext, command: string, options?: ExecOptions): Promise<ExecResult>;
  abstract test(context: ServiceContext, options?: TestOptions): Promise<TestResult>;
  abstract restore(context: ServiceContext, backupId: string, options?: RestoreOptions): Promise<RestoreResult>;
  abstract collectLogs(context: ServiceContext): Promise<CheckResult['logs']>;
  abstract getPlatformName(): string;
  
  /**
   * Helper to generate container/instance names
   */
  protected getResourceName(context: ServiceContext): string {
    return `semiont-${context.name}-${context.environment}`;
  }
  
  /**
   * Helper to detect container runtime
   */
  protected detectContainerRuntime(): 'docker' | 'podman' {
    const fs = require('fs');
    return fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
  }
}