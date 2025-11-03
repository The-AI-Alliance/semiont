/**
 * Frontend Service
 * 
 * Represents web user interfaces, static sites, and client-side applications.
 * Frontend services serve HTML, CSS, JavaScript, and other static assets,
 * often with build steps for modern frameworks.
 * 
 * Common Use Cases:
 * - React, Vue, Angular single-page applications
 * - Static site generators (Next.js, Gatsby, Hugo)
 * - Progressive Web Apps (PWAs)
 * - Mobile web applications
 * - Documentation sites and marketing pages
 * 
 * Default Requirements:
 * - Compute: 256MB RAM, 0.25 CPU cores (for build/serve)
 * - Network: Exposes port 3001 for development server
 * - Storage: 512MB ephemeral for build artifacts
 * - Build: Often requires Node.js build step
 * 
 * Platform Adaptations:
 * - Process: Runs development server or builds to static files
 * - Container: Nginx/Apache serving built assets
 * - AWS: Deployed to S3 + CloudFront for static hosting
 * - External: Points to existing CDN or hosting service
 * 
 * Supports hot module replacement in development, CDN integration,
 * compression, caching strategies, and SSL/TLS termination.
 */

import { BaseService } from '../core/base-service.js';
import { CommandExtensions } from '../core/command-result.js';
import { getNodeEnvForEnvironment } from '@semiont/core';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { ServiceRequirements, RequirementPresets } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';

export class FrontendService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Frontend typically needs network access and build capabilities
    const base = RequirementPresets.webFrontend();
    
    // Override network ports to use the configured port
    const requirements: ServiceRequirements = {
      ...base,
      network: {
        ...base.network,
        ports: [this.getPort()], // Use configured port instead of preset's [80, 443]
        healthCheckPort: this.getPort()
      },
      annotations: {
        ...base.annotations,
        // Service type declaration
        'service/type': SERVICE_TYPES.FRONTEND,
        // Frontend can be built and published as container or static assets
        [COMMAND_CAPABILITY_ANNOTATIONS.PUBLISH]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.UPDATE]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.TEST]: 'true',
        // Frontend doesn't support these data operations
        [COMMAND_CAPABILITY_ANNOTATIONS.BACKUP]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.RESTORE]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.EXEC]: 'false'
      }
    };
    
    // Add dockerfile path if semiontRepo is provided
    if (this.config.semiontRepo) {
      requirements.build = {
        ...requirements.build,
        dockerfile: `${this.config.semiontRepo}/apps/frontend/Dockerfile`,
        buildContext: this.config.semiontRepo,
        prebuilt: false
      };
    }
    
    return requirements;
  }
  
  // =====================================================================
  // Service-specific configuration
  // =====================================================================
  
  override getPort(): number {
    return this.config.port || 3000;
  }
  
  override getHealthEndpoint(): string {
    return '/'; // Frontend usually serves index.html at root
  }
  
  
  override getImage(): string {
    return this.config.image || 'semiont/frontend:latest';
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();

    return {
      ...baseEnv,
      NODE_ENV: getNodeEnvForEnvironment(this.envConfig),
      PORT: this.getPort().toString(),
      NEXT_PUBLIC_API_URL: this.getBackendUrl(),
      NEXT_PUBLIC_SITE_NAME: `Semiont ${this.systemConfig.environment}`,
      PUBLIC_URL: this.getPublicUrl()
    };
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async checkHealth(): Promise<CommandExtensions['health']> {
    const endpoint = `http://localhost:${this.getPort()}/`;
    
    try {
      const startTime = Date.now();
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(5000)
      });
      const responseTime = Date.now() - startTime;
      
      return {
        healthy: response.ok,
        details: { 
          endpoint,
          statusCode: response.status,
          responseTime,
          contentType: response.headers.get('content-type'),
          message: response.ok ? 'Frontend serving' : 'Frontend not serving'
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
      case 'container':
        return this.collectContainerLogs();
      case 'aws':
        return this.collectAWSLogs();
      default:
        // Frontend process logs usually go to console, not files
        return undefined;
    }
  }
  
  private async collectContainerLogs(): Promise<CommandExtensions['logs']> {
    const containerName = `semiont-frontend-${this.config.environment}`;
    const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
    
    try {
      const logs = execSync(
        `${runtime} logs --tail 50 ${containerName} 2>&1`,
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
    // CloudWatch logs for frontend (if using ECS/Fargate)
    try {
      const logGroup = `/ecs/semiont-${this.config.environment}-frontend`;
      const logsJson = execSync(
        `aws logs tail ${logGroup} --max-items 50 --format json 2>/dev/null`,
        { encoding: 'utf-8' }
      );
      
      const events = JSON.parse(logsJson);
      const logs = events.map((e: any) => e.message);
      
      return {
        recent: logs.slice(-10),
        errors: logs.filter((l: string) => l.match(/\berror\b/i)).slice(-10)
      };
    } catch {
      // Frontend might be static S3/CloudFront, no logs
      return undefined;
    }
  }
  
  // =====================================================================
  // Helper methods
  // =====================================================================
  
  private getBackendUrl(): string {
    switch (this.platform) {
      case 'posix':
        return 'http://localhost:3001';
      case 'container':
        return 'http://semiont-backend:3001';
      case 'aws':
        return `https://api-${this.config.environment}.semiont.com`;
      case 'external':
        return this.config.backendUrl || 'http://localhost:3001';
      default:
        return 'http://localhost:3001';
    }
  }
  
  private getPublicUrl(): string {
    switch (this.platform) {
      case 'aws':
        return `https://${this.config.environment}.semiont.com`;
      default:
        return `http://localhost:${this.getPort()}`;
    }
  }
}