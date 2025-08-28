/**
 * Platform Strategy Interface
 * 
 * Defines how services are managed across different deployment platforms.
 * Each platform (process, container, AWS, external) implements this interface
 * to provide platform-specific behavior for common operations.
 */

import { ServiceName } from '../services/service-interface.js';
import { StartResult } from '../commands/start.js';
import { StopResult } from '../commands/stop.js';
import { CheckResult } from '../commands/check.js';
import { UpdateResult } from '../commands/update.js';
import { ProvisionResult } from '../commands/provision.js';
import { PublishResult } from '../commands/publish.js';
import { BackupResult } from '../commands/backup.js';
import { ExecResult, ExecOptions } from '../commands/exec.js';
import { TestResult, TestOptions } from '../commands/test.js';
import { RestoreResult, RestoreOptions } from '../commands/restore.js';

/**
 * Secret management options
 */
export interface SecretOptions {
  environment?: string;
  format?: 'json' | 'string' | 'env';
  encrypted?: boolean;
  ttl?: number; // Time to live in seconds
}

/**
 * Result of secret management operations
 */
export interface SecretResult {
  success: boolean;
  action: 'get' | 'set' | 'list' | 'delete';
  secretPath: string;
  value?: any; // Only for 'get' action
  values?: string[]; // Only for 'list' action
  platform: string;
  storage?: string; // Where secret is stored (e.g., 'aws-secrets-manager', 'env-file', 'docker-secret')
  error?: string;
  metadata?: Record<string, any>;
}
import { ServiceConfig } from '../lib/cli-config.js';
import { Environment } from '../lib/environment-validator.js';
import { 
  ServiceRequirements, 
  StorageRequirement, 
  NetworkRequirement, 
  ResourceRequirement, 
  BuildRequirement,
  SecurityRequirement 
} from '../lib/service-requirements.js';

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
  
  // New requirement methods
  getRequirements(): ServiceRequirements;
  
  // Convenience methods for specific requirements
  needsPersistentStorage(): boolean;
  getStorageRequirements(): StorageRequirement[];
  getNetworkRequirements(): NetworkRequirement | undefined;
  getDependencyServices(): ServiceName[];
  getBuildRequirements(): BuildRequirement | undefined;
  getResourceRequirements(): ResourceRequirement | undefined;
  getSecurityRequirements(): SecurityRequirement | undefined;
  getRequiredSecrets(): string[];
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
  
  /**
   * Manage secrets for this platform
   * @param action - The secret operation to perform
   * @param secretPath - Path/name of the secret
   * @param value - Value to set (only for 'set' action)
   * @param options - Additional options for secret management
   */
  manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    value?: any,
    options?: SecretOptions
  ): Promise<SecretResult>;
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
   * Default implementation throws - platforms should override
   */
  async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    value?: any,
    options?: SecretOptions
  ): Promise<SecretResult> {
    return {
      success: false,
      action,
      secretPath,
      platform: this.getPlatformName(),
      error: `Secret management not implemented for ${this.getPlatformName()} platform`
    };
  }
  
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