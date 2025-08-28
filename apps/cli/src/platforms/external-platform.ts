/**
 * External Platform Strategy - Refactored with Requirements Pattern
 * 
 * Manages references to services running on external infrastructure.
 * Uses requirements to validate configuration and provide appropriate guidance.
 */

import { BasePlatformStrategy, ServiceContext } from './platform-strategy.js';
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
import { printInfo, printWarning } from '../lib/cli-logger.js';

export class ExternalPlatformStrategy extends BasePlatformStrategy {
  getPlatformName(): string {
    return 'external';
  }
  
  async start(context: ServiceContext): Promise<StartResult> {
    const requirements = context.getRequirements();
    
    if (!context.quiet) {
      printInfo(`Verifying external ${context.name} service configuration...`);
    }
    
    // Build endpoint from configuration and network requirements
    const endpoint = this.buildEndpoint(context.config, requirements);
    
    // Validate required configuration based on requirements
    this.validateConfiguration(context.config, requirements);
    
    return {
      entity: context.name,
      platform: 'external',
      success: true,
      startTime: new Date(),
      endpoint,
      metadata: {
        message: `External service configured${endpoint ? ` at ${endpoint}` : ''}`,
        provider: context.config.provider,
        region: context.config.region
      }
    };
  }
  
  async stop(context: ServiceContext): Promise<StopResult> {
    if (!context.quiet) {
      printWarning(`Cannot stop external ${context.name} service - managed externally`);
    }
    
    return {
      entity: context.name,
      platform: 'external',
      success: true,
      stopTime: new Date(),
      metadata: {
        message: 'External service must be stopped through its own management interface'
      }
    };
  }
  
  async check(context: ServiceContext): Promise<CheckResult> {
    const requirements = context.getRequirements();
    const endpoint = this.buildEndpoint(context.config, requirements);
    
    let status: CheckResult['status'] = 'unknown';
    let health: CheckResult['health'] | undefined;
    
    // Try health check if we have a health check path from requirements
    if (endpoint && requirements.network?.healthCheckPath) {
      try {
        const healthUrl = `${endpoint}${requirements.network.healthCheckPath}`;
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });
        
        status = response.ok ? 'running' : 'unhealthy';
        health = {
          endpoint: healthUrl,
          statusCode: response.status,
          healthy: response.ok
        };
      } catch (error) {
        // Can't reach the service
        health = {
          endpoint: `${endpoint}${requirements.network.healthCheckPath}`,
          healthy: false,
          details: {
            message: 'Could not reach external service - may be behind firewall',
            error: (error as Error).message
          }
        };
      }
    }
    
    return {
      entity: context.name,
      platform: 'external',
      success: true,
      checkTime: new Date(),
      status,
      stateVerified: false, // Can never truly verify external state
      health,
      metadata: {
        endpoint,
        provider: context.config.provider,
        message: 'External service status cannot be reliably determined'
      }
    };
  }
  
  async update(context: ServiceContext): Promise<UpdateResult> {
    if (!context.quiet) {
      printWarning(`Cannot update external ${context.name} service - managed externally`);
    }
    
    return {
      entity: context.name,
      platform: 'external',
      success: true,
      updateTime: new Date(),
      strategy: 'none',
      metadata: {
        message: 'External service must be updated through its own management interface',
        provider: context.config.provider
      }
    };
  }
  
  async provision(context: ServiceContext): Promise<ProvisionResult> {
    const requirements = context.getRequirements();
    
    if (!context.quiet) {
      printWarning(`Cannot provision external ${context.name} service - managed externally`);
      printInfo('Validating configuration instead...');
    }
    
    // Validate we have necessary configuration for requirements
    this.validateConfiguration(context.config, requirements);
    
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
      entity: context.name,
      platform: 'external',
      success: true,
      provisionTime: new Date(),
      dependencies,
      metadata: {
        provider: context.config.provider,
        externalDependencies: externalDepsStatus,
        message: 'External service configuration validated. Actual provisioning must be done externally.'
      }
    };
  }
  
  async publish(context: ServiceContext): Promise<PublishResult> {
    if (!context.quiet) {
      printWarning(`Cannot publish to external ${context.name} service - managed externally`);
    }
    
    const requirements = context.getRequirements();
    const recommendations = this.getPublishRecommendations(requirements);
    
    return {
      entity: context.name,
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
  
  async backup(context: ServiceContext): Promise<BackupResult> {
    const requirements = context.getRequirements();
    const backupId = `${context.name}-${context.environment}-${Date.now()}`;
    
    if (!context.quiet) {
      printWarning(`Cannot backup external ${context.name} service - managed externally`);
      printInfo('External services must be backed up through their own backup systems');
    }
    
    const recommendations = this.getBackupRecommendations(requirements);
    
    return {
      entity: context.name,
      platform: 'external',
      success: true,
      backupTime: new Date(),
      backupId,
      restore: {
        supported: false
      },
      metadata: {
        message: 'External services cannot be backed up through Semiont',
        recommendations,
        provider: context.config.provider
      }
    };
  }
  
  async exec(context: ServiceContext, command: string, _options: ExecOptions = {}): Promise<ExecResult> {
    const requirements = context.getRequirements();
    const execTime = new Date();
    
    if (!context.quiet) {
      printWarning(`Cannot execute commands on external ${context.name} service - managed externally`);
    }
    
    const recommendations = this.getExecRecommendations(context.config, requirements);
    
    return {
      entity: context.name,
      platform: 'external',
      success: false,
      execTime,
      command,
      error: 'External services cannot execute commands through Semiont',
      metadata: {
        message: 'Command execution not available for external services',
        provider: context.config.provider,
        recommendations
      }
    };
  }
  
  async test(context: ServiceContext, options: TestOptions = {}): Promise<TestResult> {
    const requirements = context.getRequirements();
    const endpoint = this.buildEndpoint(context.config, requirements);
    const testTime = new Date();
    
    if (!context.quiet) {
      printWarning(`Cannot run tests inside external ${context.name} service`);
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
          entity: context.name,
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
          entity: context.name,
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
      entity: context.name,
      platform: 'external',
      success: false,
      testTime,
      suite: options.suite || 'unit',
      error: 'Cannot run tests on external services',
      metadata: {
        recommendations,
        provider: context.config.provider
      }
    };
  }
  
  async restore(context: ServiceContext, backupId: string, _options: RestoreOptions = {}): Promise<RestoreResult> {
    const requirements = context.getRequirements();
    const restoreTime = new Date();
    
    if (!context.quiet) {
      printWarning(`Cannot directly restore external ${context.name} service`);
      printInfo('Providing guidance for manual restore process');
    }
    
    const guidance = this.getRestoreGuidance(context.config, requirements, backupId);
    
    return {
      entity: context.name,
      platform: 'external',
      success: false,
      restoreTime,
      backupId,
      error: 'External services must be restored through their own management interfaces',
      warnings: guidance.warnings,
      metadata: {
        provider: context.config.provider,
        instructions: guidance.instructions,
        requirements: guidance.requirements,
        estimatedTime: guidance.estimatedTime,
        documentation: guidance.documentation
      }
    };
  }
  
  async collectLogs(_context: ServiceContext): Promise<CheckResult['logs']> {
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
  private getBackupRecommendations(requirements: any): string[] {
    const recommendations: string[] = [];
    
    if (requirements.storage?.some((s: any) => s.type === 'database')) {
      recommendations.push(
        'Use database-native backup tools (pg_dump, mysqldump, mongodump)',
        'Configure automated backups in your database provider',
        'Consider point-in-time recovery options',
        'Test backup restoration procedures regularly'
      );
    }
    
    if (requirements.storage?.some((s: any) => s.type === 'filesystem')) {
      recommendations.push(
        'Use cloud storage backup features',
        'Configure automated snapshots',
        'Implement cross-region replication',
        'Document access patterns and permissions'
      );
    }
    
    if (requirements.network?.needsLoadBalancer) {
      recommendations.push(
        'Use CDN/hosting provider backup features',
        'Maintain source code in version control',
        'Document deployment procedures',
        'Consider blue-green deployment strategies'
      );
    }
    
    if (requirements.build?.dockerfile) {
      recommendations.push(
        'Maintain container images in registry',
        'Use infrastructure as code',
        'Document service dependencies'
      );
    }
    
    if (recommendations.length === 0) {
      recommendations.push(
        'Consult service provider documentation for backup options',
        'Implement monitoring and alerting',
        'Document service configuration and dependencies'
      );
    }
    
    return recommendations;
  }
  
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
  
  private getRestoreGuidance(config: any, requirements: any, backupId: string): any {
    const guidance: any = {
      instructions: [],
      requirements: [],
      warnings: [],
      estimatedTime: 'Varies by service',
      documentation: 'Consult provider documentation'
    };
    
    // Provider-specific guidance
    if (config.provider) {
      guidance.instructions.push(
        `1. Log into ${config.provider} console`,
        `2. Navigate to backup/restore section`,
        `3. Find backup: ${backupId}`,
        `4. Follow ${config.provider} restore procedure`
      );
      
      switch (config.provider) {
        case 'aws':
          guidance.documentation = 'https://docs.aws.amazon.com/';
          guidance.estimatedTime = '15-60 minutes';
          break;
        case 'gcp':
          guidance.documentation = 'https://cloud.google.com/docs';
          guidance.estimatedTime = '10-45 minutes';
          break;
        case 'azure':
          guidance.documentation = 'https://docs.microsoft.com/azure/';
          guidance.estimatedTime = '15-60 minutes';
          break;
      }
    }
    
    // Storage-specific guidance
    if (requirements.storage?.some((s: any) => s.type === 'database')) {
      guidance.instructions = [
        `1. Access database management console`,
        `2. Locate backup section`,
        `3. Find backup with ID: ${backupId}`,
        `4. Initiate restore to new or existing instance`,
        `5. Update connection strings if endpoint changes`,
        `6. Verify data integrity`
      ];
      guidance.requirements.push(
        'Database admin credentials',
        'Sufficient storage space',
        'Backup must exist in system'
      );
      guidance.warnings.push(
        'May cause downtime',
        'Connection strings may need updating'
      );
    }
    
    if (requirements.storage?.some((s: any) => s.type === 'filesystem')) {
      guidance.instructions.push(
        'Restore files from backup location',
        'Verify file permissions',
        'Update mount points if needed'
      );
      guidance.requirements.push(
        'Storage admin access',
        'Sufficient storage quota'
      );
    }
    
    // Add general requirements
    guidance.requirements.push(
      'Access to external service provider',
      'Appropriate permissions for restore operation'
    );
    
    guidance.warnings.push(
      'Ensure compatibility with current version',
      'May require configuration updates after restore'
    );
    
    return guidance;
  }
  
  /**
   * Manage secrets for external services
   * This is a basic implementation - real external services would have their own secret management
   */
  override async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    _value?: any,
    _options?: import('./platform-strategy.js').SecretOptions
  ): Promise<import('./platform-strategy.js').SecretResult> {
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
}