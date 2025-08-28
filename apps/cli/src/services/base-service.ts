/**
 * Base Service Implementation
 * 
 * Services provide capabilities and configuration to platforms.
 * All services are ServiceContexts - they provide the hooks platforms need.
 */

import { Service, ServiceName } from './service-interface.js';
import { Config, ServiceConfig } from '../lib/cli-config.js';
import { Platform } from '../platforms/platform-resolver.js';
import { 
  ServiceRequirements,
  StorageRequirement,
  NetworkRequirement,
  ResourceRequirement,
  BuildRequirement,
  SecurityRequirement
} from '../services/service-requirements.js';

export abstract class BaseService implements Service {
  protected readonly systemConfig: Config;
  public readonly config: ServiceConfig;
  protected envVars: Record<string, string | undefined> = {};
  
  constructor(
    public readonly name: ServiceName,
    public readonly platform: Platform,
    systemConfig: Config,
    serviceConfig: ServiceConfig
  ) {
    this.systemConfig = systemConfig;
    this.config = serviceConfig;
    this.envVars = { ...process.env } as Record<string, string | undefined>;
  }
  
  // =====================================================================
  // Service Context Implementation
  // These methods provide service-specific information to the platform
  // =====================================================================
  
  get environment() { return this.systemConfig.environment; }
  get projectRoot() { return this.systemConfig.projectRoot; }
  get verbose() { return this.systemConfig.verbose || false; }
  get quiet() { return this.systemConfig.quiet || false; }
  get dryRun() { return this.systemConfig.dryRun || false; }
  
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
   * Override in service implementations
   */
  getCommand(): string {
    return this.config.command || 'npm start';
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
    if (this.systemConfig.environment) {
      envVars.NODE_ENV = this.systemConfig.environment;
    }
    
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