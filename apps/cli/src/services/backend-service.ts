import { BaseService } from './base-service.js';
import { StartResult } from './types.js';
import { spawn } from 'child_process';
import * as path from 'path';
import { runContainer } from '../lib/container-runtime.js';
import { loadEnvironmentConfig, getNodeEnvForEnvironment } from '../lib/deployment-resolver.js';
import { printWarning } from '../lib/cli-logger.js';

export class BackendService extends BaseService {
  protected async preStart(): Promise<void> {
    // Backend always needs database config
    if (!this.getEnvVar('DATABASE_URL')) {
      const defaultUrl = this.getDefaultDatabaseUrl();
      this.setEnvVar('DATABASE_URL', defaultUrl);
    }
    
    // Backend always needs JWT secret
    if (!this.getEnvVar('JWT_SECRET')) {
      this.setEnvVar('JWT_SECRET', process.env.JWT_SECRET || 'local-dev-secret');
    }
    
    // Load environment-specific config
    const envConfig = loadEnvironmentConfig(this.config.environment);
    
    // Set site configuration
    if (envConfig.site?.domain) {
      this.setEnvVar('SITE_DOMAIN', envConfig.site.domain);
    }
    if (envConfig.site?.oauthAllowedDomains) {
      this.setEnvVar('OAUTH_ALLOWED_DOMAINS', envConfig.site.oauthAllowedDomains.join(','));
    }
    
    // Common backend environment
    this.setEnvVar('NODE_ENV', getNodeEnvForEnvironment(this.config.environment));
    this.setEnvVar('SEMIONT_ENV', this.config.environment);
    this.setEnvVar('PORT', (this.serviceConfig.port || 3001).toString());
  }
  
  protected async postStart(): Promise<void> {
    // Could add health check waiting here
    // For now, keeping it simple
  }
  
  protected async doStart(): Promise<StartResult> {
    switch (this.deployment) {
      case 'process':
        return this.startAsProcess();
      case 'container':
        return this.startAsContainer();
      case 'aws':
        return this.startAsAWS();
      case 'external':
        return this.startAsExternal();
      default:
        throw new Error(`Unsupported deployment type: ${this.deployment}`);
    }
  }
  
  private async startAsProcess(): Promise<StartResult> {
    const backendDir = path.join(this.config.projectRoot, 'apps/backend');
    const command = this.serviceConfig.command?.split(' ') || ['npm', 'run', 'dev'];
    const port = this.serviceConfig.port || 3001;
    
    const proc = spawn(command[0], command.slice(1), {
      cwd: backendDir,
      stdio: 'pipe',
      detached: true,
      env: this.envVars
    });
    
    proc.unref();
    
    return {
      service: this.name,
      deployment: this.deployment,
      success: true,
      startTime: new Date(),
      endpoint: `http://localhost:${port}`,
      pid: proc.pid,
      metadata: {
        command: command.join(' '),
        workingDirectory: backendDir,
        port
      }
    };
  }
  
  private async startAsContainer(): Promise<StartResult> {
    const containerName = `semiont-backend-${this.config.environment}`;
    const imageName = this.serviceConfig.image || 'semiont-backend:latest';
    const port = this.serviceConfig.port || 3001;
    
    const success = await runContainer(imageName, containerName, {
      ports: { [port.toString()]: port.toString() },
      environment: this.envVars,
      detached: true,
      verbose: this.config.verbose
    });
    
    if (!success) {
      throw new Error(`Failed to start backend container: ${containerName}`);
    }
    
    return {
      service: this.name,
      deployment: this.deployment,
      success: true,
      startTime: new Date(),
      endpoint: `http://localhost:${port}`,
      containerId: containerName,
      metadata: {
        containerName,
        image: imageName,
        port
      }
    };
  }
  
  private async startAsAWS(): Promise<StartResult> {
    // AWS ECS service start
    if (!this.config.quiet) {
      printWarning('ECS service start not yet implemented - use AWS Console or CDK');
    }
    
    return {
      service: this.name,
      deployment: this.deployment,
      success: true,
      startTime: new Date(),
      metadata: {
        serviceName: `semiont-${this.config.environment}-backend`,
        cluster: `semiont-${this.config.environment}`,
        implementation: 'pending'
      }
    };
  }
  
  private async startAsExternal(): Promise<StartResult> {
    // External service - just report it exists
    return {
      service: this.name,
      deployment: this.deployment,
      success: true,
      startTime: new Date(),
      endpoint: this.serviceConfig.endpoint,
      metadata: {
        configured: true
      }
    };
  }
  
  private getDefaultDatabaseUrl(): string {
    switch (this.deployment) {
      case 'process':
        return 'postgresql://postgres:localpassword@localhost:5432/semiont';
      case 'container':
        return 'postgresql://postgres:localpassword@semiont-postgres:5432/semiont';
      case 'aws':
        // Would read from environment or SSM
        return process.env.DATABASE_URL || '';
      case 'external':
        const { host, port, name, user, password } = this.serviceConfig;
        return `postgresql://${user}:${password}@${host}:${port}/${name}`;
      default:
        return '';
    }
  }
}