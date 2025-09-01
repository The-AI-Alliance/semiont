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
import { StartResult } from '../../core/commands/start.js';
import { StopResult } from '../../core/commands/stop.js';
import { CheckResult } from '../../core/commands/check.js';
import { UpdateResult } from '../../core/commands/update.js';
import { ProvisionResult } from '../../core/commands/provision.js';
import { PublishResult } from '../../core/commands/publish.js';
import { ExecResult, ExecOptions } from '../../core/commands/exec.js';
import { TestResult, TestOptions } from '../../core/commands/test.js';
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
  
  async start(service: Service): Promise<StartResult> {
    const requirements = service.getRequirements();
    
    if (!service.quiet) {
      printInfo(`Verifying external ${service.name} service configuration...`);
    }
    
    // Build endpoint from configuration and network requirements
    const endpoint = this.buildEndpoint(service.config, requirements);
    
    // Validate required configuration based on requirements
    this.validateConfiguration(service.config, requirements);
    
    return {
      entity: service.name,
      platform: 'external',
      success: true,
      startTime: new Date(),
      endpoint,
      metadata: {
        message: `External service configured${endpoint ? ` at ${endpoint}` : ''}`,
        provider: service.config.provider,
        region: service.config.region
      }
    };
  }
  
  async stop(service: Service): Promise<StopResult> {
    if (!service.quiet) {
      printWarning(`Cannot stop external ${service.name} service - managed externally`);
    }
    
    return {
      entity: service.name,
      platform: 'external',
      success: true,
      stopTime: new Date(),
      metadata: {
        message: 'External service must be stopped through its own management interface'
      }
    };
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
    
    const requirements = service.getRequirements();
    const recommendations = this.getPublishRecommendations(requirements);
    
    return {
      entity: service.name,
      platform: 'external',
      success: true,
      publishTime: new Date(),
      rollback: {
        supported: false
      },
      metadata: {
        message: 'External services must be published through their own deployment pipelines',
        recommendations
      }
    };
  }
  
  async exec(service: Service, command: string, _options: ExecOptions = {}): Promise<ExecResult> {
    const requirements = service.getRequirements();
    const execTime = new Date();
    
    if (!service.quiet) {
      printWarning(`Cannot execute commands on external ${service.name} service - managed externally`);
    }
    
    const recommendations = this.getExecRecommendations(service.config, requirements);
    
    return {
      entity: service.name,
      platform: 'external',
      success: false,
      execTime,
      command,
      error: 'External services cannot execute commands through Semiont',
      metadata: {
        message: 'Command execution not available for external services',
        provider: service.config.provider,
        recommendations
      }
    };
  }
  
  async test(service: Service, options: TestOptions = {}): Promise<TestResult> {
    const requirements = service.getRequirements();
    const endpoint = this.buildEndpoint(service.config, requirements);
    const testTime = new Date();
    
    if (!service.quiet) {
      printWarning(`Cannot run tests inside external ${service.name} service`);
      printInfo('Running smoke tests against external endpoints instead');
    }
    
    // Try connectivity test if we have a health check endpoint
    if (endpoint && requirements.network?.healthCheckPath) {
      try {
        const startTime = Date.now();
        const healthUrl = `${endpoint}${requirements.network.healthCheckPath}`;
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });
        
        return {
          entity: service.name,
          platform: 'external',
          success: response.ok,
          testTime,
          suite: 'smoke',
          passed: response.ok ? 1 : 0,
          failed: response.ok ? 0 : 1,
          duration: Date.now() - startTime,
          metadata: {
            message: 'External service smoke test via health endpoint',
            endpoint: healthUrl,
            statusCode: response.status
          }
        };
      } catch (error) {
        return {
          entity: service.name,
          platform: 'external',
          success: false,
          testTime,
          suite: 'smoke',
          error: `Failed to reach external service: ${error}`,
          metadata: {
            endpoint,
            recommendations: [
              'Verify external service is running',
              'Check network connectivity',
              'Ensure correct endpoint configuration'
            ]
          }
        };
      }
    }
    
    const recommendations = this.getTestRecommendations(requirements);
    
    return {
      entity: service.name,
      platform: 'external',
      success: false,
      testTime,
      suite: options.suite || 'unit',
      error: 'Cannot run tests on external services',
      metadata: {
        recommendations,
        provider: service.config.provider
      }
    };
  }
  
  async collectLogs(_service: Service): Promise<CheckResult['logs']> {
    // Can't collect logs from external services
    return undefined;
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
   * Get recommendations based on requirements
   */
  private getExecRecommendations(config: any, requirements: any): string[] {
    const recommendations: string[] = [];
    
    if (requirements.storage?.some((s: any) => s.type === 'database')) {
      const host = config.host || '<host>';
      const user = config.user || '<user>';
      const database = config.database || config.name || '<database>';
      recommendations.push(
        `Use database client: psql -h ${host} -U ${user} -d ${database}`,
        'Set up SSH tunnel if database is behind firewall',
        'Use database management tools (pgAdmin, MySQL Workbench)',
        'Consider using database proxy for secure connections'
      );
    }
    
    if (config.ssh || config.sshHost) {
      const sshHost = config.sshHost || config.host || '<host>';
      const sshUser = config.sshUser || 'user';
      recommendations.push(
        `Use SSH to connect: ssh ${sshUser}@${sshHost}`,
        'Set up SSH key authentication',
        'Use SSH config for easier access'
      );
    }
    
    if (config.provider) {
      switch (config.provider) {
        case 'aws':
          recommendations.push(
            'Use AWS CLI: aws ssm start-session',
            'Use AWS Systems Manager Session Manager',
            'Use ECS Exec for container access'
          );
          break;
        case 'gcp':
          recommendations.push(
            'Use gcloud CLI: gcloud compute ssh',
            'Use Cloud Shell for web-based access'
          );
          break;
        case 'azure':
          recommendations.push(
            'Use Azure CLI: az vm run-command',
            'Use Azure Cloud Shell'
          );
          break;
      }
    }
    
    if (requirements.network?.needsLoadBalancer) {
      recommendations.push(
        'Frontend is typically static - no execution needed',
        'Use browser developer tools for debugging',
        'Access through CDN management console'
      );
    }
    
    if (recommendations.length === 0) {
      recommendations.push(
        'Check external service documentation',
        'Use service provider management console',
        'Set up appropriate access credentials'
      );
    }
    
    return recommendations;
  }
  
  private getTestRecommendations(requirements: any): string[] {
    const recommendations: string[] = [];
    
    if (requirements.network?.healthCheckPath) {
      recommendations.push(
        'Implement health check monitoring',
        'Set up synthetic monitoring for endpoints',
        'Use external monitoring services (Datadog, New Relic)'
      );
    }
    
    if (requirements.storage?.some((s: any) => s.type === 'database')) {
      recommendations.push(
        'Run test queries against the database',
        'Use database performance monitoring',
        'Implement data validation tests'
      );
    }
    
    if (requirements.annotations?.['test/external-suite']) {
      recommendations.push(
        `Use external test suite: ${requirements.annotations['test/external-suite']}`,
        'Schedule regular test runs',
        'Monitor test results'
      );
    }
    
    recommendations.push(
      'Implement contract testing',
      'Use API testing tools for endpoints',
      'Set up end-to-end tests from your application'
    );
    
    return recommendations;
  }
  
  private getPublishRecommendations(requirements: any): string[] {
    const recommendations: string[] = [];
    
    if (requirements.build?.dockerfile) {
      recommendations.push(
        'Build and push container images to registry',
        'Use CI/CD pipeline for automated deployments',
        'Maintain version tags for rollback'
      );
    }
    
    if (requirements.annotations?.['external/deploy-method']) {
      recommendations.push(
        `Use deployment method: ${requirements.annotations['external/deploy-method']}`,
        'Follow provider-specific deployment procedures'
      );
    }
    
    if (requirements.network?.customDomains) {
      recommendations.push(
        'Update DNS records after deployment',
        'Configure SSL certificates',
        'Set up CDN if not already configured'
      );
    }
    
    recommendations.push(
      'Use external service deployment pipeline',
      'Document deployment procedures',
      'Implement deployment validation tests'
    );
    
    return recommendations;
  }
  
  /**
   * Manage secrets for external services
   * This is a basic implementation - real external services would have their own secret management
   */
  override async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    _value?: any,
    _options?: import('../../core/platform-strategy.js').SecretOptions
  ): Promise<import('../../core/platform-strategy.js').SecretResult> {
    // External platforms typically manage their own secrets
    // This implementation returns appropriate responses without actual storage
    
    switch (action) {
      case 'get':
        return {
          success: false,
          action,
          secretPath,
          platform: 'external',
          storage: 'external-provider',
          error: 'External services manage their own secrets. Check provider documentation.'
        };
        
      case 'set':
        return {
          success: true,
          action,
          secretPath,
          platform: 'external',
          storage: 'external-provider',
          metadata: {
            note: 'Secret should be configured directly in the external service provider'
          }
        };
        
      case 'list':
        return {
          success: true,
          action,
          secretPath,
          values: [],
          platform: 'external',
          storage: 'external-provider',
          metadata: {
            note: 'External secrets are managed by the service provider'
          }
        };
        
      case 'delete':
        return {
          success: true,
          action,
          secretPath,
          platform: 'external',
          storage: 'external-provider'
        };
        
      default:
        return {
          success: false,
          action,
          secretPath,
          platform: 'external',
          error: `Unknown action: ${action}`
        };
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