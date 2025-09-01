/**
 * Platform Strategy Interface
 * 
 * Defines how services are managed across different deployment platforms.
 * Each platform (process, container, AWS, external) implements this interface
 * to provide platform-specific behavior for common operations.
 */

// Command result types are now under core/commands
import { Service } from '../services/types.js';
import { StartResult } from './commands/start.js';
import { StopResult } from './commands/stop.js';
import { CheckResult } from './commands/check.js';
import { UpdateResult } from './commands/update.js';
import { ProvisionResult } from './commands/provision.js';
import { PublishResult } from './commands/publish.js';
import { ExecResult, ExecOptions } from './commands/exec.js';
import { TestResult, TestOptions } from './commands/test.js';

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
// ServiceContext has been merged into Service interface
// Services now contain all the context that platforms need

/**
 * Platform strategy interface
 * Implemented by each deployment platform (process, container, AWS, external)
 */
export interface PlatformStrategy {

  getResourceName(service: Service): string;

  determineServiceType(service: Service): string;

  /**
   * Build platform-specific context extensions for handlers
   * Including resource discovery if needed
   */
  buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>>;
  /**
   * Start a service on this platform
   */
  start(service: Service): Promise<StartResult>;
  
  /**
   * Stop a service on this platform
   */
  stop(service: Service): Promise<StopResult>;
  
  /**
   * Update a service on this platform
   */
  update(service: Service): Promise<UpdateResult>;
  
  /**
   * Provision infrastructure and resources for a service on this platform
   */
  provision(service: Service): Promise<ProvisionResult>;
  
  /**
   * Publish artifacts and deploy service content on this platform
   */
  publish(service: Service): Promise<PublishResult>;
  
  /**
   * Execute a command in the service context on this platform
   */
  exec(service: Service, command: string, options?: ExecOptions): Promise<ExecResult>;
  
  /**
   * Run tests for a service on this platform
   */
  test(service: Service, options?: TestOptions): Promise<TestResult>;
  
  /**
   * Collect logs from a service on this platform
   */
  collectLogs(service: Service): Promise<CheckResult['logs']>;
  
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
  
  /**
   * Quick check if a service is running without full context
   */
  quickCheckRunning?(state: import('./state-manager.js').ServiceState): Promise<boolean>;
}

/**
 * Base platform strategy with common functionality
 */
export abstract class BasePlatformStrategy implements PlatformStrategy {

  abstract determineServiceType(service: Service): string;
  abstract buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>>;
  
  abstract start(service: Service): Promise<StartResult>;
  abstract stop(service: Service): Promise<StopResult>;
  abstract update(service: Service): Promise<UpdateResult>;
  abstract provision(service: Service): Promise<ProvisionResult>;
  abstract publish(service: Service): Promise<PublishResult>;
  abstract exec(service: Service, command: string, options?: ExecOptions): Promise<ExecResult>;
  abstract test(service: Service, options?: TestOptions): Promise<TestResult>;
  abstract collectLogs(service: Service): Promise<CheckResult['logs']>;
  abstract getPlatformName(): string;
  
  async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    _value?: any,
    _options?: SecretOptions
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
   * Quick check if a service is running without full context
   * Default implementation returns false
   */
  async quickCheckRunning(_state: import('./state-manager.js').ServiceState): Promise<boolean> {
    return false;
  }
  
  /**
   * Helper to generate container/instance names
   */
  public getResourceName(service: Service): string {
    return `semiont-${service.name}-${service.environment}`;
  }
  
  /**
   * Helper to detect container runtime
   */
  protected detectContainerRuntime(): 'docker' | 'podman' {
    const fs = require('fs');
    return fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
  }
}