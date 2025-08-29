/**
 * Generic Service
 * 
 * A flexible service implementation for custom or unrecognized service types.
 * This service adapts to any configuration, making it useful for prototyping,
 * legacy systems, or services that don't fit standard categories.
 * 
 * Common Use Cases:
 * - Custom microservices with unique requirements
 * - Third-party applications wrapped as services
 * - Legacy systems being migrated incrementally
 * - Experimental or prototype services
 * - Services with highly dynamic configurations
 * 
 * Requirements:
 * - Fully configurable via service configuration
 * - Derives all settings from environment config
 * - No default assumptions about resources
 * - Platform-specific hints in configuration
 * 
 * Platform Adaptations:
 * - Process: Uses configured command and environment
 * - Container: Uses configured image or Dockerfile
 * - AWS: Interprets config for appropriate AWS service
 * - External: Acts as a proxy to external endpoints
 * 
 * The ultimate fallback that ensures any service can be managed
 * through Semiont, even without a dedicated service class.
 * Configuration-driven behavior allows complete customization.
 */

import { BaseService } from './base-service.js';
import { ServiceRequirements, StorageRequirement } from '../services/service-requirements.js';
import { ServiceName } from './service-interface.js';

export class GenericService extends BaseService {
  
  // =====================================================================
  // Service Requirements - Derived from Configuration
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    const requirements: ServiceRequirements = {};
    
    // Network requirements from config
    if (this.config.port || this.config.ports) {
      const ports = this.config.ports || [this.config.port];
      requirements.network = {
        ports: ports.filter(Boolean) as number[],
        protocol: this.config.protocol as 'tcp' | 'udp' || 'tcp',
        needsLoadBalancer: this.config.loadBalancer || false,
        healthCheckPath: this.config.healthCheck || undefined,
        healthCheckPort: this.config.healthCheckPort || ports[0],
        customDomains: this.config.domains as string[] || undefined
      };
    }
    
    // Storage requirements from config
    if (this.config.storage) {
      const storageConfig = this.config.storage;
      const storage: StorageRequirement[] = Array.isArray(storageConfig) 
        ? storageConfig 
        : [storageConfig];
        
      requirements.storage = storage.map(s => ({
        persistent: s.persistent !== false,
        volumeName: s.volumeName || `${this.name}-data-${this.systemConfig.environment}`,
        size: s.size || '1Gi',
        mountPath: s.mountPath || '/data',
        type: s.type || 'volume',
        backupEnabled: s.backupEnabled || false
      }));
    }
    
    // Dependencies from config
    if (this.config.dependencies) {
      requirements.dependencies = {
        services: (Array.isArray(this.config.dependencies) 
          ? this.config.dependencies 
          : [this.config.dependencies]) as ServiceName[]
      };
    }
    
    // External dependencies from config
    if (this.config.externalDependencies) {
      requirements.dependencies = {
        services: requirements.dependencies?.services || [],
        external: this.config.externalDependencies.map((dep: any) => ({
          name: dep.name || dep,
          url: dep.url || undefined,
          required: dep.required !== false,
          healthCheck: dep.healthCheck || undefined
        }))
      };
    }
    
    // Resource requirements from config
    if (this.config.resources) {
      requirements.resources = {
        cpu: this.config.resources.cpu || undefined,
        memory: this.config.resources.memory || undefined,
        replicas: this.config.resources.replicas || 1,
        gpus: this.config.resources.gpus || undefined,
        ephemeralStorage: this.config.resources.ephemeralStorage || undefined
      };
    }
    
    // Build requirements from config
    if (this.config.build || this.config.dockerfile) {
      requirements.build = {
        dockerfile: this.config.dockerfile || 'Dockerfile',
        buildContext: this.config.buildContext || '.',
        buildArgs: this.config.buildArgs || {},
        prebuilt: this.config.prebuilt || false,
        target: this.config.buildTarget || undefined
      };
    }
    
    // Security requirements from config
    if (this.config.security || this.config.secrets) {
      requirements.security = {
        secrets: this.config.secrets || [],
        runAsUser: this.config.security?.runAsUser || undefined,
        runAsGroup: this.config.security?.runAsGroup || undefined,
        readOnlyRootFilesystem: this.config.security?.readOnlyRootFilesystem || false,
        allowPrivilegeEscalation: this.config.security?.allowPrivilegeEscalation || false,
        capabilities: this.config.security?.capabilities || undefined
      };
    }
    
    // Environment variables
    if (this.config.environment) {
      requirements.environment = this.config.environment;
    }
    
    // Labels
    if (this.config.labels) {
      requirements.labels = this.config.labels;
    }
    
    // Annotations (platform-specific hints)
    if (this.config.annotations) {
      requirements.annotations = this.config.annotations;
    }
    
    return requirements;
  }
  
  // =====================================================================
  // Service-specific configuration - All from config
  // =====================================================================
  
  override getPort(): number {
    return this.config.port || 3000;
  }
  
  override getHealthEndpoint(): string {
    return this.config.healthEndpoint || '/health';
  }
  
  override getCommand(): string {
    return this.config.command || 'npm start';
  }
  
  override getImage(): string {
    return this.config.image || `${this.name}:latest`;
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    const requirements = this.getRequirements();
    
    return {
      ...baseEnv,
      ...(requirements.environment || {}),
      // Add any additional env vars from config
      ...(this.config.env || {})
    };
  }
}