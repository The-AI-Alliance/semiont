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

import { BaseService } from './base-service.js';
import { CheckResult } from '../commands/check.js';
import { getNodeEnvForEnvironment } from '../platforms/platform-resolver.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { ServiceRequirements, RequirementPresets } from '../services/service-requirements.js';

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
      NODE_ENV: getNodeEnvForEnvironment(this.config.environment),
      PORT: this.getPort().toString(),
      NEXT_PUBLIC_API_URL: this.getBackendUrl(),
      NEXT_PUBLIC_SITE_NAME: `Semiont ${this.config.environment}`,
      PUBLIC_URL: this.getPublicUrl()
    };
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async checkHealth(): Promise<CheckResult['health']> {
    const endpoint = `http://localhost:${this.getPort()}/`;
    
    try {
      const startTime = Date.now();
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(5000)
      });
      const responseTime = Date.now() - startTime;
      
      return {
        endpoint,
        statusCode: response.status,
        responseTime,
        healthy: response.ok,
        details: { 
          contentType: response.headers.get('content-type'),
          message: response.ok ? 'Frontend serving' : 'Frontend not serving'
        }
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
      case 'container':
        return this.collectContainerLogs();
      case 'aws':
        return this.collectAWSLogs();
      default:
        // Frontend process logs usually go to console, not files
        return undefined;
    }
  }
  
  private async collectContainerLogs(): Promise<CheckResult['logs']> {
    const containerName = `semiont-frontend-${this.config.environment}`;
    const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
    
    try {
      const logs = execSync(
        `${runtime} logs --tail 50 ${containerName} 2>&1`,
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
        errors: logs.filter((l: string) => l.match(/\berror\b/i)).length,
        warnings: logs.filter((l: string) => l.match(/\bwarning\b/i)).length
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
      case 'process':
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