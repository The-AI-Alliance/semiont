/**
 * Base Service Implementation
 * 
 * Abstract base class for all service types in the Semiont CLI.
 * This class establishes the contract between services and platforms,
 * allowing services to declare their requirements while platforms
 * handle the actual infrastructure provisioning.
 * 
 * Key Responsibilities:
 * - Declares infrastructure requirements (compute, network, storage)
 * - Defines service capabilities (what operations are supported)
 * - Provides configuration and environment variables
 * - Implements lifecycle hooks for platform integration
 * - Manages platform strategy selection and delegation
 * 
 * Design Principles:
 * - Platform-agnostic: Services don't know how they'll be deployed
 * - Requirement-driven: Services declare what they need, not how to get it
 * - Extensible: New service types can extend and customize behavior
 * - Testable: Can be tested with mock platforms without real infrastructure
 * 
 * All concrete service types (backend, frontend, database, etc.) extend
 * this base class and override methods to specify their unique requirements
 * and behaviors.
 */

import { Service } from './service-interface.js';
import { ServiceName } from './service-discovery.js';
import { ServiceConfig } from './cli-config.js';
import { PlatformType, EnvironmentConfig, Environment } from '@semiont/core';
import {
  ServiceRequirements,
  StorageRequirement,
  NetworkRequirement,
  ResourceRequirement,
  BuildRequirement,
  SecurityRequirement
} from './service-requirements.js';

export abstract class BaseService implements Service {
  protected readonly envConfig: EnvironmentConfig;
  public readonly config: ServiceConfig;
  protected envVars: Record<string, string | undefined> = {};

  // Runtime flags
  public readonly verbose: boolean;
  public readonly quiet: boolean;
  public readonly dryRun: boolean;
  public readonly forceDiscovery: boolean;

  constructor(
    public readonly name: ServiceName,
    public readonly platform: PlatformType,
    envConfig: EnvironmentConfig,
    serviceConfig: ServiceConfig,
    runtimeFlags: {
      verbose: boolean;
      quiet: boolean;
      dryRun?: boolean;
      forceDiscovery?: boolean;
    }
  ) {
    this.envConfig = envConfig;
    this.config = serviceConfig;
    this.verbose = runtimeFlags.verbose;
    this.quiet = runtimeFlags.quiet;
    this.dryRun = runtimeFlags.dryRun || false;
    this.forceDiscovery = runtimeFlags.forceDiscovery || false;
    this.envVars = { ...process.env } as Record<string, string | undefined>;
  }
  
  // =====================================================================
  // Service Context Implementation
  // These methods provide service-specific information to the platform
  // =====================================================================

  // Derived properties from envConfig._metadata
  get environment(): Environment {
    const env = this.envConfig._metadata?.environment;
    if (!env) {
      throw new Error('Environment is required in envConfig._metadata');
    }
    return env as Environment;
  }

  get projectRoot(): string {
    const root = this.envConfig._metadata?.projectRoot;
    if (!root) {
      throw new Error('Project root is required in envConfig._metadata');
    }
    return root;
  }

  get environmentConfig() { return this.envConfig; }
  
  /**
   * Get the port for this service
   * Override in service implementations
   */
  getPort(): number {
    return this.config.port || 3000;
  }
  
  /**
   * Get the health check endpoint
   * Override in service implementations
   */
  getHealthEndpoint(): string {
    return '/health';
  }
  
  /**
   * Get the command to run for process deployment
   * Must be configured - no default
   */
  getCommand(): string {
    if (!this.config.command) {
      throw new Error(`No command configured for service '${this.name}'. Add "command" to your service configuration.`);
    }
    return this.config.command;
  }
  
  /**
   * Get the container image
   * Override in service implementations
   */
  getImage(): string {
    return this.config.image || `semiont/${this.name}:latest`;
  }
  
  /**
   * Get environment variables for the service
   * Override to add service-specific variables
   */
  getEnvironmentVariables(): Record<string, string> {
    const envVars: Record<string, string> = {};

    // Add common environment variables
    envVars.NODE_ENV = this.environment;

    // Add service-specific environment variables from config
    if (this.config.env) {
      Object.assign(envVars, this.config.env);
    }

    // Filter out undefined values
    return Object.entries(envVars).reduce((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {} as Record<string, string>);
  }
  
  // =====================================================================
  // Service Requirements - Override in service implementations
  // =====================================================================
  
  /**
   * Get service requirements for platform operations
   * Override this method to provide service-specific requirements
   */
  abstract getRequirements(): ServiceRequirements;
  
  /**
   * Check if service needs persistent storage
   */
  needsPersistentStorage(): boolean {
    const storage = this.getRequirements().storage;
    return storage ? storage.some(s => s.persistent) : false;
  }
  
  /**
   * Get storage requirements
   */
  getStorageRequirements(): StorageRequirement[] {
    return this.getRequirements().storage || [];
  }
  
  /**
   * Get network requirements
   */
  getNetworkRequirements(): NetworkRequirement | undefined {
    return this.getRequirements().network;
  }
  
  /**
   * Get service dependencies
   */
  getDependencyServices(): ServiceName[] {
    return this.getRequirements().dependencies?.services || [];
  }
  
  /**
   * Get build requirements
   */
  getBuildRequirements(): BuildRequirement | undefined {
    return this.getRequirements().build;
  }
  
  /**
   * Get resource requirements
   */
  getResourceRequirements(): ResourceRequirement | undefined {
    return this.getRequirements().resources;
  }
  
  /**
   * Get security requirements
   */
  getSecurityRequirements(): SecurityRequirement | undefined {
    return this.getRequirements().security;
  }
  
  /**
   * Get required secrets
   */
  getRequiredSecrets(): string[] {
    return this.getRequirements().security?.secrets || [];
  }
  
  // =====================================================================
  // Service-specific hooks for platforms to call
  // Override these in service implementations as needed
  // =====================================================================
  
  /**
   * Hook called before service starts
   */
  protected async preStart(): Promise<void> {
    // Override in service implementations
  }
  
  /**
   * Hook called after service starts
   */
  protected async postStart(): Promise<void> {
    // Override in service implementations
  }
  
  /**
   * Hook called before service stops
   */
  protected async preStop(): Promise<void> {
    // Override in service implementations
  }
  
  /**
   * Hook called after service stops
   */
  protected async postStop(): Promise<void> {
    // Override in service implementations
  }
  
  /**
   * Service-specific health check logic
   */
  protected async checkHealth(): Promise<any> {
    // Override in service implementations
    return { healthy: true };
  }
}