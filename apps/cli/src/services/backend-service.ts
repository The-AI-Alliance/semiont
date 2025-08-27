/**
 * Backend Service - Refactored with Platform Strategy
 * 
 */

import { BaseService } from './base-service.js';
import { CheckResult } from '../commands/check.js';
import { execSync } from 'child_process';
import { loadEnvironmentConfig, getNodeEnvForEnvironment } from '../lib/platform-resolver.js';
import * as path from 'path';
import * as fs from 'fs';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../lib/service-requirements.js';

export class BackendService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Start with stateless API preset
    const baseRequirements = RequirementPresets.statelessApi();
    
    // Define backend-specific requirements
    const backendRequirements: ServiceRequirements = {
      network: {
        ports: [this.getPort()],
        protocol: 'tcp',
        needsLoadBalancer: true,
        healthCheckPath: '/health',
        healthCheckPort: this.getPort(),
        healthCheckInterval: 30
      },
      dependencies: {
        services: ['database'],
        external: [
          {
            name: 'Redis',
            url: this.config.redisUrl,
            required: false
          }
        ]
      },
      build: {
        dockerfile: 'Dockerfile.backend',
        buildContext: path.join(this.systemConfig.projectRoot, 'apps/backend'),
        buildArgs: {
          NODE_ENV: this.systemConfig.environment,
          VERSION: process.env.VERSION || 'latest'
        },
        prebuilt: false
      },
      resources: {
        memory: this.config.memory || '512Mi',
        cpu: this.config.cpu || '0.25',
        replicas: this.systemConfig.environment === 'prod' ? 2 : 1
      },
      security: {
        secrets: ['JWT_SECRET', 'DATABASE_URL', 'API_KEY'],
        readOnlyRootFilesystem: false,  // Node.js needs write access for tmp
        allowPrivilegeEscalation: false,
        runAsUser: 1000,  // node user
        runAsGroup: 1000
      },
      environment: this.buildEnvironment()
    };
    
    // Merge preset with specific requirements
    return mergeRequirements(baseRequirements, backendRequirements);
  }
  
  private buildEnvironment(): Record<string, string> {
    const envConfig = loadEnvironmentConfig(this.systemConfig.environment);
    
    return {
      PORT: this.getPort().toString(),
      NODE_ENV: getNodeEnvForEnvironment(this.systemConfig.environment),
      SEMIONT_ENV: this.systemConfig.environment,
      SEMIONT_ENVIRONMENT: this.systemConfig.environment,
      ...(envConfig.site?.domain && { SITE_DOMAIN: envConfig.site.domain }),
      ...(envConfig.site?.oauthAllowedDomains && { 
        OAUTH_ALLOWED_DOMAINS: JSON.stringify(envConfig.site.oauthAllowedDomains) 
      })
    };
  }
  
  // =====================================================================
  // Service-specific configuration
  // =====================================================================
  
  override getPort(): number {
    return this.config.port || 3001;
  }
  
  override getHealthEndpoint(): string {
    return '/health';
  }
  
  override getCommand(): string {
    return this.config.command || 'npm run start:prod';
  }
  
  override getImage(): string {
    return this.config.image || 'semiont/backend:latest';
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    const requirements = this.getRequirements();
    
    return {
      ...baseEnv,
      ...(requirements.environment || {}),
      // Add dynamic values and secrets
      DATABASE_URL: this.getDatabaseUrl(),
      JWT_SECRET: process.env.JWT_SECRET || 'local-dev-secret',
      API_KEY: process.env.API_KEY || 'local-api-key'
    };
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async preStart(): Promise<void> {
    // Backend needs database to be available
    // This could check database connectivity
  }
  
  protected override async checkHealth(): Promise<CheckResult['health']> {
    const endpoint = `http://localhost:${this.getPort()}/health`;
    
    try {
      const startTime = Date.now();
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(5000)
      });
      const responseTime = Date.now() - startTime;
      
      let details: any = {};
      try {
        details = await response.json();
      } catch {
        details = response.ok ? { message: 'Backend healthy' } : { message: 'Backend unhealthy' };
      }
      
      return {
        endpoint,
        statusCode: response.status,
        responseTime,
        healthy: response.ok,
        details
      };
    } catch (error) {
      return {
        endpoint,
        healthy: false,
        details: { error: (error as Error).message }
      };
    }
  }
  
  protected async doCollectLogs(): Promise<CheckResult['logs']> {
    switch (this.platform) {
      case 'process':
        return this.collectProcessLogs();
      case 'container':
        return this.collectContainerLogs();
      case 'aws':
        return this.collectAWSLogs();
      default:
        return undefined;
    }
  }
  
  private async collectProcessLogs(): Promise<CheckResult['logs']> {
    const logPath = path.join(this.config.projectRoot, 'apps/backend/logs/app.log');
    const recent: string[] = [];
    let errors = 0;
    let warnings = 0;
    
    try {
      if (fs.existsSync(logPath)) {
        const logs = execSync(`tail -100 ${logPath}`, { encoding: 'utf-8' })
          .split('\n')
          .filter(line => line.trim());
        
        recent.push(...logs.slice(-10));
        logs.forEach(line => {
          if (line.match(/\berror\b/i)) errors++;
          if (line.match(/\bwarning\b/i)) warnings++;
        });
      }
    } catch {
      return undefined;
    }
    
    return {
      recent: recent.length > 0 ? recent : undefined,
      errors,
      warnings
    };
  }
  
  private async collectContainerLogs(): Promise<CheckResult['logs']> {
    const containerName = `semiont-backend-${this.config.environment}`;
    const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
    
    try {
      const logs = execSync(
        `${runtime} logs --tail 100 ${containerName} 2>&1`,
        { encoding: 'utf-8' }
      ).split('\n').filter(line => line.trim());
      
      return {
        recent: logs.slice(-10),
        errors: logs.filter(l => l.match(/\berror\b/i)).length,
        warnings: logs.filter(l => l.match(/\bwarning\b/i)).length
      };
    } catch {
      return undefined;
    }
  }
  
  private async collectAWSLogs(): Promise<CheckResult['logs']> {
    try {
      const logGroup = `/ecs/semiont-${this.config.environment}-backend`;
      const logsJson = execSync(
        `aws logs tail ${logGroup} --max-items 100 --format json 2>/dev/null`,
        { encoding: 'utf-8' }
      );
      
      const events = JSON.parse(logsJson);
      const logs = events.map((e: any) => e.message);
      
      return {
        recent: logs.slice(-10),
        errors: logs.filter((l: string) => l.match(/\berror\b/i)).length,
        warnings: logs.filter((l: string) => l.match(/\bwarning\b/i)).length
      };
    } catch {
      return undefined;
    }
  }
  
  // =====================================================================
  // Helper methods
  // =====================================================================
  
  private getDatabaseUrl(): string {
    // Service-specific logic for determining database URL
    if (this.config.databaseUrl) {
      return this.config.databaseUrl;
    }
    
    switch (this.platform) {
      case 'process':
        return 'postgresql://postgres:localpassword@localhost:5432/semiont';
      case 'container':
        return 'postgresql://postgres:localpassword@semiont-postgres:5432/semiont';
      case 'aws':
        return process.env.DATABASE_URL || '';
      case 'external':
        const { host, port, name, user, password } = this.config;
        return `postgresql://${user}:${password}@${host}:${port}/${name}`;
      default:
        return '';
    }
  }
}