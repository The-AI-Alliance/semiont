/**
 * Backend Service
 * 
 * Represents API servers, application logic, and business services.
 * Backend services typically handle HTTP requests, process business logic,
 * interact with databases, and provide APIs for frontend applications.
 * 
 * Common Use Cases:
 * - REST APIs and GraphQL servers
 * - Microservices and monolithic applications
 * - WebSocket servers and real-time services
 * - Background workers and job processors
 * - Authentication and authorization services
 * 
 * Default Requirements:
 * - Compute: 512MB RAM, 0.5 CPU cores
 * - Network: Exposes port 3000 for HTTP traffic
 * - Storage: 256MB ephemeral for temp files
 * - Dependencies: Often requires database service
 * 
 * Platform Adaptations:
 * - Process: Runs as Node.js, Python, or other runtime process
 * - Container: Packaged with dependencies in Docker image
 * - AWS: Deployed to ECS Fargate or Lambda (if stateless)
 * - External: Connects to existing backend services
 * 
 * Supports health checks, auto-scaling, load balancing, and
 * integration with monitoring and logging systems.
 */

import { BaseService } from '../core/base-service.js';
import { CommandExtensions } from '../core/command-result.js';
import { execSync } from 'child_process';
import { loadEnvironmentConfig, getNodeEnvForEnvironment } from '../core/platform-resolver.js';
import * as path from 'path';
import * as fs from 'fs';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../core/service-requirements.js';

export class BackendService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Start with stateless API preset but exclude network (we'll override it completely)
    const baseRequirements = RequirementPresets.statelessApi();
    delete baseRequirements.network; // Remove network from preset to avoid port conflicts
    
    // Add dockerfile path if semiontRepo is provided
    const buildConfig = this.config.semiontRepo ? {
      dockerfile: `${this.config.semiontRepo}/apps/backend/Dockerfile`,
      buildContext: this.config.semiontRepo,
      prebuilt: false
    } : baseRequirements.build;
    
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
      build: buildConfig || {
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
  
  protected override async checkHealth(): Promise<CommandExtensions['health']> {
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
        healthy: response.ok,
        details: {
          ...details,
          endpoint,
          statusCode: response.status,
          responseTime
        }
      };
    } catch (error) {
      return {
        healthy: false,
        details: { 
          endpoint,
          error: (error as Error).message 
        }
      };
    }
  }
  
  protected async doCollectLogs(): Promise<CommandExtensions['logs']> {
    switch (this.platform) {
      case 'posix':
        return this.collectProcessLogs();
      case 'container':
        return this.collectContainerLogs();
      case 'aws':
        return this.collectAWSLogs();
      default:
        return undefined;
    }
  }
  
  private async collectProcessLogs(): Promise<CommandExtensions['logs']> {
    const logPath = path.join(this.config.projectRoot, 'apps/backend/logs/app.log');
    const recent: string[] = [];
    const errorLogs: string[] = [];
    
    try {
      if (fs.existsSync(logPath)) {
        const logs = execSync(`tail -100 ${logPath}`, { encoding: 'utf-8' })
          .split('\n')
          .filter(line => line.trim());
        
        recent.push(...logs.slice(-10));
        logs.forEach(line => {
          if (line.match(/\berror\b/i)) errorLogs.push(line);
        });
      }
    } catch {
      return undefined;
    }
    
    return {
      recent: recent.slice(-10),
      errors: errorLogs.slice(-10)
    };
  }
  
  private async collectContainerLogs(): Promise<CommandExtensions['logs']> {
    const containerName = `semiont-backend-${this.config.environment}`;
    const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
    
    try {
      const logs = execSync(
        `${runtime} logs --tail 100 ${containerName} 2>&1`,
        { encoding: 'utf-8' }
      ).split('\n').filter(line => line.trim());
      
      return {
        recent: logs.slice(-10),
        errors: logs.filter(l => l.match(/\berror\b/i)).slice(-10)
      };
    } catch {
      return undefined;
    }
  }
  
  private async collectAWSLogs(): Promise<CommandExtensions['logs']> {
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
        errors: logs.filter((l: string) => l.match(/\berror\b/i)).slice(-10)
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
    
    // Check if DATABASE_URL is already set in environment
    if (process.env.DATABASE_URL) {
      return process.env.DATABASE_URL;
    }
    
    // Try to get database configuration from environment config
    const envConfig = loadEnvironmentConfig(this.systemConfig.environment);
    const dbConfig = envConfig.services?.database;
    
    if (dbConfig && dbConfig.platform?.type === 'external') {
      // Load secrets for database password
      const secretsPath = path.join(this.systemConfig.projectRoot, '.secrets.json');
      let password = dbConfig.password || 'password';
      
      try {
        if (fs.existsSync(secretsPath)) {
          const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
          password = secrets.DATABASE_PASSWORD || password;
        }
      } catch (e) {
        // Ignore errors reading secrets
      }
      
      const dbUrl = `postgresql://${dbConfig.user}:${password}@${dbConfig.host}:${dbConfig.port}/${dbConfig.name}`;
      
      // Debug logging for CI
      if (this.systemConfig.environment === 'ci') {
        console.log(`[DEBUG] Backend DATABASE_URL construction:`);
        console.log(`  - dbConfig: ${JSON.stringify(dbConfig)}`);
        console.log(`  - secretsPath: ${secretsPath}`);
        console.log(`  - DATABASE_URL: ${dbUrl}`);
      }
      
      return dbUrl;
    }
    
    // Fallback to platform-specific defaults
    switch (this.platform) {
      case 'posix':
        return 'postgresql://postgres:localpassword@localhost:5432/semiont';
      case 'container':
        return 'postgresql://postgres:localpassword@semiont-postgres:5432/semiont';
      case 'aws':
        return '';  // AWS should have DATABASE_URL set
      default:
        return '';
    }
  }
}