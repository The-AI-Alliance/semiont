/**
 * External Platform Strategy
 * 
 * Manages references to services that run on external infrastructure outside of
 * Semiont's control. This platform acts as a registry and health checker for
 * third-party services, SaaS offerings, and legacy systems.
 * 
 * Capabilities:
 * - Registers external service endpoints and credentials
 * - Performs health checks on external APIs and services
 * - Validates connectivity and authentication
 * - Provides a unified interface to external services
 * - Tracks external service metadata and configuration
 * 
 * Requirements Handling:
 * - Compute: Documents expected capacity but doesn't provision
 * - Network: Validates endpoints are reachable and ports are open
 * - Storage: Records external storage locations (S3, databases, etc.)
 * - Dependencies: Checks that required external services are accessible
 * - Security: Manages API keys, tokens, and connection strings securely
 * 
 * Use Cases:
 * - Third-party APIs (payment gateways, email services)
 * - Managed databases (RDS, MongoDB Atlas, etc.)
 * - SaaS services (Auth0, Stripe, SendGrid)
 * - Legacy systems that can't be migrated
 */

import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import type { 
  UpdateResult, 
  ProvisionResult,
  PublishResult,
  CheckResult 
} from '../../core/command-types.js';
import { printInfo, printWarning } from '../../core/io/cli-logger.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';

export class ExternalPlatformStrategy extends BasePlatformStrategy {
  constructor() {
    super();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('external', handlers);
  }
  
  getPlatformName(): string {
    return 'external';
  }
  
  async update(service: Service): Promise<UpdateResult> {
    if (!service.quiet) {
      printWarning(`Cannot update external ${service.name} service - managed externally`);
    }
    
    return {
      entity: service.name,
      platform: 'external',
      success: true,
      updateTime: new Date(),
      strategy: 'none',
      metadata: {
        message: 'External service must be updated through its own management interface',
        provider: service.config.provider
      }
    };
  }
  
  async provision(service: Service): Promise<ProvisionResult> {
    const requirements = service.getRequirements();
    
    if (!service.quiet) {
      printWarning(`Cannot provision external ${service.name} service - managed externally`);
      printInfo('Validating configuration instead...');
    }
    
    // Validate we have necessary configuration for requirements
    this.validateConfiguration(service.config, requirements);
    
    const dependencies = requirements.dependencies?.services || [];
    
    // Check external dependencies if specified
    const externalDepsStatus: Record<string, boolean> = {};
    if (requirements.dependencies?.external) {
      for (const ext of requirements.dependencies.external) {
        if (ext.healthCheck) {
          try {
            const response = await fetch(ext.healthCheck, {
              signal: AbortSignal.timeout(5000)
            });
            externalDepsStatus[ext.name] = response.ok;
          } catch {
            externalDepsStatus[ext.name] = false;
            if (ext.required) {
              printWarning(`Required external dependency '${ext.name}' is not reachable`);
            }
          }
        }
      }
    }
    
    return {
      entity: service.name,
      platform: 'external',
      success: true,
      provisionTime: new Date(),
      dependencies,
      metadata: {
        provider: service.config.provider,
        externalDependencies: externalDepsStatus,
        message: 'External service configuration validated. Actual provisioning must be done externally.'
      }
    };
  }
  
  async publish(service: Service): Promise<PublishResult> {
    if (!service.quiet) {
      printWarning(`Cannot publish to external ${service.name} service - managed externally`);
    }
        
    return {
      entity: service.name,
      platform: 'external',
      success: true,
      publishTime: new Date(),
      rollback: {
        supported: false
      },
      metadata: {
        message: 'External services must be published through their own deployment pipelines'
      }
    };
  }
  
  
  /**
   * Build endpoint URL from configuration and requirements
   */
  private buildEndpoint(config: any, requirements: any): string | undefined {
    // Check explicit endpoint/URL in config
    if (config.url || config.endpoint) {
      return config.url || config.endpoint;
    }
    
    // Build from host and port if available
    if (config.host) {
      const port = config.port || requirements.network?.ports?.[0];
      const protocol = requirements.network?.protocol === 'https' ? 'https' : 'http';
      
      if (requirements.storage?.some((s: any) => s.type === 'database')) {
        // Database connection string
        const dbName = config.database || config.name || 'database';
        const dbPort = port || 5432;
        return `postgresql://${config.host}:${dbPort}/${dbName}`;
      }
      
      return port ? `${protocol}://${config.host}:${port}` : `${protocol}://${config.host}`;
    }
    
    // Check for cloud provider specific endpoints
    if (config.provider === 'aws' && config.resourceId) {
      return `https://${config.resourceId}.${config.region || 'us-east-1'}.amazonaws.com`;
    }
    
    return undefined;
  }
  
  /**
   * Validate configuration based on requirements
   */
  private validateConfiguration(config: any, requirements: any): void {
    // Network requirements validation
    if (requirements.network?.ports && requirements.network.ports.length > 0) {
      if (!config.host && !config.url && !config.endpoint) {
        throw new Error('External service with network requirements needs host, url, or endpoint configuration');
      }
    }
    
    // Storage requirements validation
    if (requirements.storage?.some((s: any) => s.persistent)) {
      if (requirements.storage.some((s: any) => s.type === 'database')) {
        if (!config.host || !config.user) {
          throw new Error('External database requires host and user configuration');
        }
      } else if (!config.path && !config.url) {
        throw new Error('External storage requires path or url configuration');
      }
    }
    
    // Security requirements validation
    if (requirements.security?.secrets && requirements.security.secrets.length > 0) {
      const missingSecrets = requirements.security.secrets.filter(
        (secret: string) => !config[secret.toLowerCase()] && !process.env[secret]
      );
      
      if (missingSecrets.length > 0) {
        printWarning(`Missing secrets for external service: ${missingSecrets.join(', ')}`);
      }
    }
  }
  
  /**
   * Determine service type for handler selection
   */
  determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    const serviceName = service.name.toLowerCase();
    
    // Check for static sites/CDNs
    if (requirements.annotations?.['service/type'] === 'static' ||
        serviceName.includes('cdn') ||
        serviceName.includes('static')) {
      return 'static';
    }
    
    // Default to API for external services
    return 'api';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>> {
    const requirements = service.getRequirements();
    const endpoint = this.buildEndpoint(service.config, requirements);
    
    return {
      endpoint
    };
  }
}