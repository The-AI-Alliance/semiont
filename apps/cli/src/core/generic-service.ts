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
import { ServiceRequirements } from './service-requirements.js';
import { ServiceName } from './service-discovery.js';
import { SERVICE_TYPES, ServiceType } from './service-types.js';

export class GenericService extends BaseService {
  
  /**
   * Determine service type from config or use default
   */
  private determineServiceType(): ServiceType {
    const config = this.config as any;

    // Check explicit service type in config
    if (config.serviceType && Object.values(SERVICE_TYPES).includes(config.serviceType as ServiceType)) {
      return config.serviceType as ServiceType;
    }

    // Check annotations in config
    if (config.annotations?.['service/type'] &&
        Object.values(SERVICE_TYPES).includes(config.annotations['service/type'] as ServiceType)) {
      return config.annotations['service/type'] as ServiceType;
    }
    
    // Try to infer from service name
    const name = this.name.toLowerCase();
    if (name.includes('frontend') || name.includes('ui')) return SERVICE_TYPES.FRONTEND;
    if (name.includes('backend') || name.includes('api')) return SERVICE_TYPES.BACKEND;
    if (name.includes('database') || name.includes('db')) return SERVICE_TYPES.DATABASE;
    if (name.includes('worker') || name.includes('job')) return SERVICE_TYPES.WORKER;
    if (name.includes('inference') || name.includes('ml')) return SERVICE_TYPES.INFERENCE;
    
    // Default to generic
    return SERVICE_TYPES.GENERIC;
  }
  
  // =====================================================================
  // Service Requirements - Derived from Configuration
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    const requirements: ServiceRequirements = {};

    // Cast config to any for GenericService - it handles all config types dynamically
    const config = this.config as any;

    // Network requirements from config
    if (config.port || config.ports) {
      const ports = config.ports || [config.port];
      requirements.network = {
        ports: ports.filter(Boolean) as number[],
        protocol: config.protocol as 'tcp' | 'udp' || 'tcp',
        needsLoadBalancer: config.loadBalancer || false,
        healthCheckPath: config.healthCheck || undefined,
        healthCheckPort: config.healthCheckPort || ports[0],
        customDomains: config.domains as string[] || undefined
      };
    }
    
    // Storage requirements from config
    if (config.storage && typeof config.storage !== 'string') {
      const storageConfig = config.storage;
      const storageArray = Array.isArray(storageConfig)
        ? storageConfig
        : [storageConfig];

      requirements.storage = storageArray.map(s => ({
        persistent: s.persistent !== false,
        volumeName: s.volumeName || `${this.name}-data-${this.environment}`,
        size: s.size || '1Gi',
        mountPath: s.mountPath || '/data',
        type: (s.type || 'volume') as 'volume' | 'bind' | 'tmpfs',
        backupEnabled: false
      }));
    }

    // Dependencies from config
    if (config.dependencies) {
      requirements.dependencies = {
        services: (Array.isArray(config.dependencies)
          ? config.dependencies
          : [config.dependencies]) as ServiceName[]
      };
    }

    // External dependencies from config
    if (config.externalDependencies) {
      requirements.dependencies = {
        services: requirements.dependencies?.services || [],
        external: config.externalDependencies.map((dep: any) => ({
          name: dep.name || dep,
          url: dep.url || undefined,
          required: dep.required !== false,
          healthCheck: dep.healthCheck || undefined
        }))
      };
    }

    // Resource requirements from config
    if (config.resources) {
      requirements.resources = {
        cpu: config.resources.cpu || undefined,
        memory: config.resources.memory || undefined,
        replicas: config.resources.replicas || 1,
        gpus: config.resources.gpus || undefined,
        ephemeralStorage: config.resources.ephemeralStorage || undefined
      };
    }

    // Build requirements from config
    if (config.build || config.dockerfile) {
      requirements.build = {
        dockerfile: config.dockerfile || 'Dockerfile',
        buildContext: config.buildContext || '.',
        buildArgs: config.buildArgs || {},
        prebuilt: config.prebuilt || false,
        target: config.buildTarget || undefined
      };
    }

    // Security requirements from config
    if (config.security || config.secrets) {
      requirements.security = {
        secrets: config.secrets || [],
        runAsUser: config.security?.runAsUser || undefined,
        runAsGroup: config.security?.runAsGroup || undefined,
        readOnlyRootFilesystem: config.security?.readOnlyRootFilesystem || false,
        allowPrivilegeEscalation: config.security?.allowPrivilegeEscalation || false,
        capabilities: Array.isArray(config.security?.capabilities)
          ? { add: config.security.capabilities, drop: [] }
          : config.security?.capabilities
      };
    }

    // Environment variables
    if (config.environment) {
      requirements.environment = config.environment;
    }

    // Labels
    if (config.labels) {
      requirements.labels = config.labels;
    }

    // Annotations - MUST include service/type
    const serviceType = this.determineServiceType();
    requirements.annotations = {
      ...config.annotations,
      'service/type': serviceType
    };
    
    return requirements;
  }
  
  // =====================================================================
  // Service-specific configuration - All from config
  // =====================================================================
  
  override getPort(): number {
    const config = this.config as any;
    return config.port || 3000;
  }

  override getHealthEndpoint(): string {
    const config = this.config as any;
    return config.healthEndpoint || '/health';
  }


  override getImage(): string {
    const config = this.config as any;
    return config.image || `${this.name}:latest`;
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    const requirements = this.getRequirements();
    
    return {
      ...baseEnv,
      ...(requirements.environment || {}),
      // Add any additional env vars from config (only if object, not string path)
      ...(typeof this.config.env === 'object' ? this.config.env : {})
    };
  }
}