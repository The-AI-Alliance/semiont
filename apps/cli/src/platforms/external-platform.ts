/**
 * External Platform Strategy
 * 
 * Manages references to services running on external infrastructure
 * that we don't control directly. Can only verify configuration and
 * attempt connectivity checks.
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
    // External services don't start - just verify configuration
    const config = this.getExternalConfig(context);
    
    if (!context.quiet) {
      printInfo(`Verifying external ${context.name} service configuration...`);
    }
    
    // Validate required configuration
    this.validateConfig(context, config);
    
    return {
      entity: context.name,
      platform: 'external',
      success: true,
      startTime: new Date(),
      endpoint: config.endpoint,
      metadata: {
        message: `External service configured at ${config.endpoint}`,
        ...config
      }
    };
  }
  
  async stop(context: ServiceContext): Promise<StopResult> {
    // Can't stop external services
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
    const config = this.getExternalConfig(context);
    
    // For external services, we can't reliably determine status
    // Best we can do is check if configuration looks valid
    let status: CheckResult['status'] = 'unknown';
    let health: CheckResult['health'] | undefined;
    
    // Try to ping the service if we have an endpoint
    if (config.endpoint) {
      try {
        const healthEndpoint = context.getHealthEndpoint();
        const fullUrl = `${config.endpoint}${healthEndpoint}`;
        
        // Attempt a simple fetch to check connectivity
        const response = await fetch(fullUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });
        
        if (response.ok) {
          status = 'running';
          health = {
            endpoint: fullUrl,
            statusCode: response.status,
            healthy: true
          };
        } else {
          status = 'unhealthy';
          health = {
            endpoint: fullUrl,
            statusCode: response.status,
            healthy: false
          };
        }
      } catch {
        // Can't reach the service, but that doesn't mean it's down
        // It might be behind a firewall or VPN
        status = 'unknown';
        health = {
          endpoint: config.endpoint,
          healthy: false,
          details: {
            message: 'Could not reach external service - may be behind firewall'
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
        ...config,
        message: 'External service status cannot be reliably determined'
      }
    };
  }
  
  async update(context: ServiceContext): Promise<UpdateResult> {
    // Can't update external services
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
        message: 'External service must be updated through its own management interface'
      }
    };
  }
  
  async provision(context: ServiceContext): Promise<ProvisionResult> {
    // Can't provision external services - just validate configuration
    if (!context.quiet) {
      printWarning(`Cannot provision external ${context.name} service - managed externally`);
      printInfo('Validating configuration instead...');
    }
    
    const config = this.getExternalConfig(context);
    this.validateConfig(context, config);
    
    return {
      entity: context.name,
      platform: 'external',
      success: true,
      provisionTime: new Date(),
      metadata: {
        ...config,
        message: 'External service configuration validated. Actual provisioning must be done externally.'
      }
    };
  }
  
  async publish(context: ServiceContext): Promise<PublishResult> {
    // Can't publish to external services - they're managed externally
    if (!context.quiet) {
      printWarning(`Cannot publish to external ${context.name} service - managed externally`);
    }
    
    return {
      entity: context.name,
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
  
  async backup(context: ServiceContext): Promise<BackupResult> {
    // Can't backup external services - they're managed externally
    if (!context.quiet) {
      printWarning(`Cannot backup external ${context.name} service - managed externally`);
      printInfo('External services must be backed up through their own backup systems');
    }
    
    const backupId = `${context.name}-${context.environment}-${Date.now()}`;
    
    return {
      entity: context.name,
      platform: 'external',
      success: true, // "Success" means we acknowledged the limitation
      backupTime: new Date(),
      backupId,
      restore: {
        supported: false
      },
      metadata: {
        message: 'External services cannot be backed up through Semiont. Use the external service\'s own backup mechanisms.',
        recommendations: this.getBackupRecommendations(context.name)
      }
    };
  }
  
  async exec(context: ServiceContext, command: string, _options: ExecOptions = {}): Promise<ExecResult> {
    // Can't exec on external services - they're managed externally
    if (!context.quiet) {
      printWarning(`Cannot execute commands on external ${context.name} service - managed externally`);
      printInfo('External services must be accessed through their own interfaces');
    }
    
    const execTime = new Date();
    const config = this.getExternalConfig(context);
    
    // Provide helpful guidance based on service type
    const recommendations = this.getExecRecommendations(context.name, config);
    
    return {
      entity: context.name,
      platform: 'external',
      success: false,
      execTime,
      command,
      error: 'External services cannot execute commands through Semiont. Use the service\'s own management interface.',
      metadata: {
        message: 'Command execution not available for external services',
        serviceConfig: config,
        recommendations
      }
    };
  }
  
  /**
   * Get exec recommendations for external services
   */
  private getExecRecommendations(serviceName: string, config: Record<string, any>): string[] {
    switch (serviceName) {
      case 'database':
        return [
          `Use database client: psql -h ${config.host || 'host'} -U ${config.user || 'user'} -d ${config.database || 'database'}`,
          'Set up SSH tunnel if database is behind firewall',
          'Use database management tools (pgAdmin, MySQL Workbench)',
          'Consider using database proxy for secure connections'
        ];
        
      case 'backend':
        if (config.endpoint) {
          return [
            `Use SSH to connect to backend server: ssh user@${new URL(config.endpoint).hostname}`,
            'Use the provider\'s web console or CLI tools',
            'Set up remote debugging if needed',
            'Use API testing tools for HTTP endpoints'
          ];
        }
        return [
          'Use SSH to connect to backend server',
          'Use cloud provider CLI (aws, gcloud, az)',
          'Access through Kubernetes kubectl if containerized',
          'Use remote development tools (VS Code Remote)'
        ];
        
      case 'frontend':
        return [
          'Frontend is typically static files - no execution needed',
          'Use CDN management console for cache operations',
          'Deploy changes through CI/CD pipeline',
          'Use browser developer tools for debugging'
        ];
        
      case 'filesystem':
        return [
          'Mount the external filesystem locally',
          'Use file management tools (rsync, scp)',
          'Access through cloud storage CLI tools',
          'Use FUSE mounts for transparent access'
        ];
        
      case 'mcp':
      case 'agent':
        return [
          'Use service-specific management interface',
          'Check service provider documentation',
          'Use API or SDK for programmatic access',
          'Set up monitoring and logging'
        ];
        
      default:
        return [
          'Check external service documentation',
          'Use service provider\'s management console',
          'Set up appropriate access credentials',
          'Consider using service-specific CLI tools'
        ];
    }
  }
  
  async test(context: ServiceContext, options: TestOptions = {}): Promise<TestResult> {
    // External services can only be tested via API/smoke tests
    const testTime = new Date();
    const config = this.getExternalConfig(context);
    
    if (!context.quiet) {
      printWarning(`Cannot run tests inside external ${context.name} service`);
      printInfo('Running smoke tests against external endpoints instead');
    }
    
    // Try basic connectivity test
    if (config.endpoint) {
      try {
        const startTime = Date.now();
        const response = await fetch(`${config.endpoint}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });
        
        return {
          entity: context.name,
          platform: 'external',
          success: response.ok,
          testTime,
          suite: 'smoke',
          tests: {
            total: 1,
            passed: response.ok ? 1 : 0,
            failed: response.ok ? 0 : 1,
            duration: Date.now() - startTime
          },
          metadata: {
            message: 'External service smoke test via health endpoint',
            endpoint: config.endpoint,
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
            recommendations: [
              'Verify external service is running',
              'Check network connectivity',
              'Ensure correct endpoint configuration',
              'Use external service\'s own test suite'
            ]
          }
        };
      }
    }
    
    return {
      entity: context.name,
      platform: 'external',
      success: false,
      testTime,
      suite: options.suite || 'unit',
      error: 'Cannot run tests on external services. Use the service\'s own test infrastructure.',
      metadata: {
        recommendations: this.getTestRecommendations(context.name)
      }
    };
  }
  
  private getTestRecommendations(serviceName: string): string[] {
    switch (serviceName) {
      case 'database':
        return [
          'Connect to external database and run test queries',
          'Use database\'s built-in testing tools',
          'Run integration tests from your application'
        ];
      case 'frontend':
        return [
          'Use external monitoring tools',
          'Implement synthetic monitoring',
          'Run end-to-end tests against the deployed URL'
        ];
      default:
        return [
          'Use the external service\'s testing infrastructure',
          'Implement contract testing',
          'Set up monitoring and alerting'
        ];
    }
  }
  
  async restore(context: ServiceContext, backupId: string, _options: RestoreOptions = {}): Promise<RestoreResult> {
    const restoreTime = new Date();
    const config = this.getExternalConfig(context);
    
    if (!context.quiet) {
      printWarning(`Cannot directly restore external ${context.name} service`);
      printInfo('Providing guidance for manual restore process');
    }
    
    // Service-specific restore guidance
    const guidance = this.getRestoreGuidance(context.name, backupId, config);
    
    return {
      entity: context.name,
      platform: 'external',
      success: false,
      restoreTime,
      backupId,
      error: 'External services must be restored through their own management interfaces',
      warnings: guidance.warnings,
      metadata: {
        provider: config.provider || 'unknown',
        instructions: guidance.instructions,
        requirements: guidance.requirements,
        estimatedTime: guidance.estimatedTime,
        documentation: guidance.documentation
      }
    };
  }
  
  private getRestoreGuidance(serviceName: string, backupId: string, config: any) {
    switch (serviceName) {
      case 'database':
        return {
          instructions: [
            `1. Log into your database provider's console (${config.provider || 'provider console'})`,
            `2. Navigate to the backups/snapshots section`,
            `3. Find backup with ID or timestamp: ${backupId}`,
            `4. Initiate restore process following provider's procedure`,
            `5. Update connection strings if endpoint changes`,
            `6. Verify data integrity after restore`
          ],
          requirements: [
            'Database admin credentials',
            'Access to provider console',
            'Backup must exist in provider\'s system'
          ],
          warnings: [
            'Restoring may cause downtime',
            'Connection strings may need updating',
            'Some data loss possible depending on backup frequency'
          ],
          estimatedTime: '15-60 minutes',
          documentation: config.provider === 'aws' 
            ? 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_CommonTasks.BackupRestore.html'
            : 'Check your provider\'s documentation'
        };
        
      case 'filesystem':
        return {
          instructions: [
            `1. Access your cloud storage provider (${config.provider || 'provider'})`,
            `2. Navigate to backup location`,
            `3. Find backup version: ${backupId}`,
            `4. Restore files to original location`,
            `5. Verify file permissions and access`
          ],
          requirements: [
            'Storage admin access',
            'Backup exists in storage system'
          ],
          warnings: [
            'May overwrite existing files',
            'Check storage costs for restore operations'
          ],
          estimatedTime: '5-30 minutes',
          documentation: 'Provider-specific documentation required'
        };
        
      case 'frontend':
        return {
          instructions: [
            `1. Access your CDN/hosting provider`,
            `2. Locate deployment history or backups`,
            `3. Find version: ${backupId}`,
            `4. Rollback to selected version`,
            `5. Clear CDN cache if applicable`,
            `6. Verify deployment`
          ],
          requirements: [
            'Deployment platform access',
            'Version/backup availability'
          ],
          warnings: [
            'Users may need to clear browser cache',
            'CDN propagation may take time'
          ],
          estimatedTime: '5-15 minutes',
          documentation: 'Check your hosting provider\'s rollback procedures'
        };
        
      default:
        return {
          instructions: [
            `1. Access your external service provider`,
            `2. Navigate to backup/restore section`,
            `3. Select backup: ${backupId}`,
            `4. Follow provider\'s restore procedure`,
            `5. Update configuration if needed`,
            `6. Test service after restore`
          ],
          requirements: [
            'Service admin access',
            'Backup availability'
          ],
          warnings: [
            'Service-specific considerations apply',
            'May require configuration updates'
          ],
          estimatedTime: 'Varies by service',
          documentation: 'Consult service provider documentation'
        };
    }
  }
  
  async collectLogs(_context: ServiceContext): Promise<CheckResult['logs']> {
    // Can't collect logs from external services
    return undefined;
  }
  
  /**
   * Get backup recommendations for external services
   */
  private getBackupRecommendations(serviceName: string): string[] {
    switch (serviceName) {
      case 'database':
        return [
          'Use database-native backup tools (pg_dump, mysqldump, etc.)',
          'Configure automated backups in your database provider',
          'Consider point-in-time recovery options',
          'Test backup restoration procedures regularly'
        ];
      case 'frontend':
        return [
          'Use CDN/hosting provider backup features',
          'Maintain source code in version control',
          'Document deployment procedures',
          'Consider blue-green deployment strategies'
        ];
      case 'backend':
        return [
          'Use cloud provider backup services',
          'Implement infrastructure as code',
          'Maintain container/VM images',
          'Document service dependencies and configurations'
        ];
      case 'filesystem':
        return [
          'Use cloud storage backup features',
          'Configure automated snapshots',
          'Implement cross-region replication',
          'Document access patterns and permissions'
        ];
      default:
        return [
          'Consult service provider documentation for backup options',
          'Implement monitoring and alerting',
          'Document service configuration and dependencies'
        ];
    }
  }
  
  /**
   * Get external service configuration
   */
  private getExternalConfig(context: ServiceContext): Record<string, any> {
    const config: Record<string, any> = {};
    
    switch (context.name) {
      case 'backend':
        config.endpoint = context.config.url || context.config.endpoint;
        config.apiKey = context.config.apiKey;
        break;
        
      case 'frontend':
        config.endpoint = context.config.url || context.config.endpoint;
        break;
        
      case 'database':
        config.host = context.config.host;
        config.port = context.config.port || 5432;
        config.database = context.config.name || context.config.database;
        config.user = context.config.user;
        config.endpoint = `postgresql://${config.host}:${config.port}/${config.database}`;
        break;
        
      case 'filesystem':
        config.path = context.config.path;
        config.type = context.config.type || 'network-mount';
        break;
        
      default:
        config.endpoint = context.config.url || context.config.endpoint;
    }
    
    return config;
  }
  
  /**
   * Validate external service configuration
   */
  private validateConfig(context: ServiceContext, config: Record<string, any>): void {
    switch (context.name) {
      case 'backend':
        if (!config.endpoint) {
          throw new Error('External backend requires endpoint configuration');
        }
        break;
        
      case 'frontend':
        if (!config.endpoint) {
          throw new Error('External frontend requires endpoint configuration');
        }
        break;
        
      case 'database':
        if (!config.host || !config.user) {
          throw new Error('External database requires host and user configuration');
        }
        break;
        
      case 'filesystem':
        if (!config.path) {
          throw new Error('External filesystem requires path configuration');
        }
        break;
    }
  }
}