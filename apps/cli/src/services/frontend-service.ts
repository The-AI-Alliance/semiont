import { BaseService } from './base-service.js';
import { StartResult } from './types.js';
import { spawn } from 'child_process';
import * as path from 'path';
import { runContainer } from '../lib/container-runtime.js';
import { getNodeEnvForEnvironment } from '../lib/deployment-resolver.js';
import { printWarning } from '../lib/cli-logger.js';

export class FrontendService extends BaseService {
  protected async preStart(): Promise<void> {
    // Frontend environment setup
    this.setEnvVar('NODE_ENV', getNodeEnvForEnvironment(this.config.environment));
    this.setEnvVar('PORT', (this.serviceConfig.port || 3000).toString());
    
    // Frontend needs to know where the backend is
    const backendUrl = this.getBackendUrl();
    this.setEnvVar('NEXT_PUBLIC_API_URL', backendUrl);
    
    // Site configuration
    this.setEnvVar('NEXT_PUBLIC_SITE_NAME', `Semiont ${this.config.environment}`);
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
    const frontendDir = path.join(this.config.projectRoot, 'apps/frontend');
    const command = this.serviceConfig.command?.split(' ') || ['npm', 'run', 'dev'];
    const port = this.serviceConfig.port || 3000;
    
    const proc = spawn(command[0], command.slice(1), {
      cwd: frontendDir,
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
        workingDirectory: frontendDir,
        port
      }
    };
  }
  
  private async startAsContainer(): Promise<StartResult> {
    const containerName = `semiont-frontend-${this.config.environment}`;
    const imageName = this.serviceConfig.image || 'semiont-frontend:latest';
    const port = this.serviceConfig.port || 3000;
    
    const success = await runContainer(imageName, containerName, {
      ports: { [port.toString()]: port.toString() },
      environment: this.envVars,
      detached: true,
      verbose: this.config.verbose
    });
    
    if (!success) {
      throw new Error(`Failed to start frontend container: ${containerName}`);
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
        serviceName: `semiont-${this.config.environment}-frontend`,
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
  
  private getBackendUrl(): string {
    switch (this.deployment) {
      case 'process':
        return 'http://localhost:3001';
      case 'container':
        return 'http://semiont-backend:3001';
      case 'aws':
        return `https://api-${this.config.environment}.semiont.com`;
      case 'external':
        return this.serviceConfig.backendUrl || 'http://localhost:3001';
      default:
        return 'http://localhost:3001';
    }
  }
}